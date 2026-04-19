# End-to-end flow and credential storage

This document walks through the full journey from a fresh deploy to a live board, and explains **where every secret lives**, **why the setup wizard only asks for Client ID and Client Secret**, and **how access tokens and refresh tokens fit in** (they are created automatically after OAuth; you never paste them into the app).

---

## Two different kinds of “Strava credentials”

Strava uses standard **OAuth 2.0**. This project separates two layers:

| Layer | What it is | Who it identifies | Stored where |
| --- | --- | --- | --- |
| **Strava application** | `client_id` + `client_secret` | Your *developer app* on Strava | KV `config:strava_app` (or env fallback — see below) |
| **Strava user (athlete) tokens** | `access_token` + `refresh_token` + `expires_at` | The *athlete* who authorized the app | KV `tokens:<athlete_id>` |

The **setup wizard** only collects the **application** pair. That is enough to:

1. Build the “authorize this app” URL (needs `client_id`).
2. Exchange the **authorization `code`** Strava sends to your callback for **user tokens** (needs `client_id` + `client_secret` + `code`).

The **browser never receives** the `client_secret`, the refresh token, or a long-lived bearer token for API calls. Those exist only on the Worker and in KV.

---

## Where credentials and tokens are stored (KV)

Everything below lives in the single Cloudflare KV namespace bound as `STRAVA_KV` (see [`wrangler.jsonc`](../wrangler.jsonc)).

| KV key | Contents | Used for |
| --- | --- | --- |
| `config:strava_app` | JSON: `{ "client_id", "client_secret" }` | OAuth authorize URL, token exchange, token refresh |
| `config:session_secret` | Random hex string (auto-generated on first use unless `SESSION_SECRET` env is set) | HMAC signing of `sid` (Strava owner session) and `admin_sid` (setup admin session) cookies |
| `config:admin` | JSON: admin username + PBKDF2 password hash (setup gate before claim) | Gating setup + Strava OAuth start until an athlete has claimed the instance |
| `owner:athlete_id` | Plain number string | Single-owner model: which Strava account owns this Worker |
| `tokens:<athlete_id>` | JSON: `{ "access_token", "refresh_token", "expires_at" }` | Calling Strava’s REST API as that athlete |
| `cache:athlete`, `cache:activities`, `cache:stats`, `cache:lastSyncedAt` | Public-ish board data (no secrets) | What `/api/*` reads for the SPA |
| `lock:sync` | Short-lived lock | Avoid concurrent syncs |

### Optional: environment variable fallback for app credentials

For local development, [`worker/config.ts`](../worker/config.ts) resolves Strava app credentials in this order:

1. KV `config:strava_app` (wizard or API write).
2. If missing: `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` from the Worker environment (e.g. `.dev.vars` or Wrangler secrets).

If you already used the wizard (KV has credentials) but want to **iterate on Client ID/Secret from `.dev.vars`**, set **`STRAVA_PREFER_DEV_VARS=true`** (or `1`) in `.dev.vars` so env wins over KV. When the Client ID or Secret **value changes**, the Worker clears owner, tokens, caches, and wizard-stored app config (see [`worker/dev-strava-reset.ts`](../worker/dev-strava-reset.ts)), then you **Connect with Strava** again. Restart the dev server after edits. Do not set this in production.

So in dev you can skip re-entering the wizard every time by putting the app pair in `.dev.vars`. Production is intended to use KV from the wizard.

---

## Why the setup flow does not ask for a refresh token or bearer token

Those values are **not something you create manually**. They are issued by Strava **after** a user completes the OAuth consent screen.

Sequence:

1. User clicks **Connect with Strava** → browser goes to Strava’s authorize URL with your `client_id` and `redirect_uri` (see [`worker/auth.ts`](../worker/auth.ts) `loginRedirect`).
2. User approves → Strava redirects back to **`/auth/strava/callback?code=...`** with a **short-lived authorization code** (not a bearer token for general API use).
3. The Worker calls Strava’s token endpoint **from the server** with `grant_type=authorization_code`, `client_id`, `client_secret`, and `code` (see [`worker/strava.ts`](../worker/strava.ts) `exchangeCode`).
4. Strava responds with `access_token`, `refresh_token`, and `expires_at`. The Worker persists them under `tokens:<athlete_id>` and sets the signed `sid` cookie (see [`worker/auth.ts`](../worker/auth.ts) `handleCallback`).

So the “missing” refresh and bearer tokens in the wizard are **by design**: they appear only after OAuth, and only the Worker stores them.

---

## How bearer tokens are used after that (server-side only)

[`worker/strava.ts`](../worker/strava.ts) implements `getAccessToken`:

- If the stored access token is still valid (more than ~60 seconds before expiry), it returns that token.
- Otherwise it calls Strava with `grant_type=refresh_token`, using the stored refresh token and the **same** `client_id` / `client_secret`, then updates KV.

`stravaFetch` then calls Strava’s REST API with:

`Authorization: Bearer <access_token>`

That header is built **inside the Worker**. The React app’s `/api/me`, `/api/activities`, etc. **never** proxy raw Strava calls; they read **cached** JSON from KV (see [`worker/index.ts`](../worker/index.ts) and [`worker/sync.ts`](../worker/sync.ts)).

---

## End-to-end flow (from zero to public board)

### Phase 0: Deploy

- Cloudflare provisions the Worker, KV binding `STRAVA_KV`, and (if configured) cron.
- No Strava secrets are required at deploy time.

### Phase 1: First browser visit — admin gate (pre-claim)

1. Operator opens the Worker URL (or `npm run dev` locally).
2. If the instance is **not** fully set up (`configured` + `claimed` in the sense the UI uses), the SPA loads [`src/App.tsx`](../src/App.tsx) and shows **AdminAuth** until `admin_sid` is valid.
3. First visitor registers **GitHub username + password** → `POST /api/admin/register` → KV `config:admin` (password hashed; see [`worker/admin.ts`](../worker/admin.ts)).
4. Subsequent visitors before claim see **login** instead of register.

**Security note:** The admin password is never stored in plaintext. Session cookies are HMAC-signed with `config:session_secret` (or `SESSION_SECRET` env).

### Phase 2: Strava application credentials (wizard)

1. Authenticated admin sees **SetupWizard** ([`src/components/SetupWizard.tsx`](../src/components/SetupWizard.tsx)).
2. Operator creates a Strava API application at [https://www.strava.com/settings/api](https://www.strava.com/settings/api) and sets **Authorization Callback Domain** to the Worker’s host (shown in the wizard).
3. Operator pastes **Client ID** and **Client Secret** → `POST /api/setup` → KV `config:strava_app`.

**Security note:** `POST /api/setup` is gated: before an athlete claims the instance, only a valid **admin** session can write (see [`worker/setup.ts`](../worker/setup.ts)). The `client_secret` is written to KV as JSON; it is not echoed to the client in responses.

### Phase 3: OAuth — athlete claims the instance

1. Operator clicks **Connect with Strava** → `GET /auth/strava/login` (still admin-gated until claim — [`worker/auth.ts`](../worker/auth.ts)).
2. Browser redirects to Strava; user approves scopes (`read`, `activity:read_all`).
3. Strava redirects to `GET /auth/strava/callback?code=...`.
4. Worker exchanges `code` for tokens, sets `owner:athlete_id`, writes `tokens:<id>`, sets `sid` cookie, triggers initial sync in the background.

**Security note:** If `owner:athlete_id` already exists and a different athlete completes OAuth, the callback returns **403** (see `handleCallback`).

### Phase 4: Data sync — population and refresh

1. **Immediate:** `runSync` reads tokens from KV, calls Strava with `Authorization: Bearer`, writes trimmed activity JSON and stats into `cache:*` keys ([`worker/sync.ts`](../worker/sync.ts)).
2. **Scheduled:** Cron invokes the same `runSync` path on the Worker (no browser).
3. **Manual:** Owner can `POST /api/sync` with a valid `sid` cookie (see [`worker/index.ts`](../worker/index.ts)). The production SPA hides the in-app control; it appears only in Vite dev (`npm run dev`) to avoid burning quota in production.

### Phase 5: Day-to-day usage — public board

1. After claim, the SPA treats the instance as “live” and loads `/api/me`, `/api/activities`, `/api/stats` from **cache** only.
2. Strava tokens remain in KV; the general public never receives them.
3. Rotating the Strava **client secret** (or full app config) can be done via the wizard again when authenticated as owner **or** admin (see `handleSetupSave` in [`worker/setup.ts`](../worker/setup.ts)).

---

## Security properties (summary)

| Asset | Reaches the browser? | Notes |
| --- | --- | --- |
| `client_secret` | No | Only in KV (or server env); used only in Worker→Strava server-side POSTs |
| `refresh_token` / `access_token` | No | KV only; bearer used only inside `stravaFetch` |
| Authorization `code` | Yes, briefly in URL | One-time use; exchanged immediately on the server |
| `sid` / `admin_sid` | Cookie only (opaque signed blob) | Payload is verified with `SESSION_SECRET` / KV session secret |
| Cached activities / athlete / stats | Yes, via `/api/*` | Intentionally public read model for the board |

**Threat model highlights:**

- **KV compromise** is treated as high impact: an attacker with read access to the namespace could read app secrets and user tokens. Mitigations are Cloudflare’s access controls on the account, least-privilege API tokens, and rotating secrets if a namespace is exposed.
- **First visitor to the URL** could historically race the setup wizard; the **admin gate** narrows that to “first successful admin registration” before Strava OAuth or setup writes are allowed (pre-claim).

---

## OAuth flow (diagram)

```mermaid
sequenceDiagram
  participant Browser
  participant Worker
  participant Strava

  Browser->>Worker: GET /auth/strava/login
  Worker->>Browser: 302 to Strava authorize
  Browser->>Strava: User approves
  Strava->>Browser: 302 to /auth/strava/callback?code=...
  Browser->>Worker: GET /auth/strava/callback?code=...
  Worker->>Strava: POST /oauth/token (code + client_id + client_secret)
  Strava->>Worker: access_token, refresh_token, expires_at
  Worker->>Worker: KV put tokens:athleteId, owner:athlete_id
  Worker->>Browser: 302 / + Set-Cookie sid=...
  Note over Worker,Strava: Later syncs: Bearer access_token; refresh when near expiry
```

---

## Code map (quick reference)

| Concern | Primary files |
| --- | --- |
| KV keys / token storage | [`worker/kv.ts`](../worker/kv.ts) |
| Resolve app config + session secret | [`worker/config.ts`](../worker/config.ts) |
| OAuth redirect + callback + owner cookie | [`worker/auth.ts`](../worker/auth.ts) |
| Token exchange, refresh, Strava HTTP | [`worker/strava.ts`](../worker/strava.ts) |
| Cron / manual sync using tokens | [`worker/sync.ts`](../worker/sync.ts), [`worker/index.ts`](../worker/index.ts) |
| Setup wizard API + admin gate on save | [`worker/setup.ts`](../worker/setup.ts), [`worker/admin.ts`](../worker/admin.ts) |

For a shorter deploy-oriented overview, see the root [README.md](../README.md).

---

## Admin password (lightweight gate)

The setup admin password is only meant to block casual drive-by visitors before Strava claim. It uses **salted PBKDF2-SHA256** with a **low iteration count** (10,000) so registration stays fast and stays well under Cloudflare’s PBKDF2 iteration cap (values above **100,000** can throw in production — [error 1101](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1101/) if the script throws). Minimum password length is **8** characters ([`worker/admin.ts`](../worker/admin.ts)).
