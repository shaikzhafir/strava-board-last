import type { Env, StravaAppConfig } from "./types";

const KEY_STRAVA_APP = "config:strava_app";
const KEY_SESSION_SECRET = "config:session_secret";

/** When true, `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` from env win over KV (local dev). */
export function prefersStravaFromEnv(env: Env): boolean {
  const v = env.STRAVA_PREFER_DEV_VARS;
  return v === "true" || v === "1";
}

/**
 * Resolve the effective Strava app credentials.
 *
 * Default order (production and typical local):
 *   1. KV (set via the in-app setup wizard)
 *   2. Environment variables (wrangler secrets / `.dev.vars`)
 *   3. null — caller must prompt the operator to configure.
 *
 * When `STRAVA_PREFER_DEV_VARS` is `"true"` or `"1"` (set in `.dev.vars` for local
 * iteration only), order 1–2 swap so env wins. Changing Client ID/Secret triggers
 * [`reconcileDevStravaAppSwitch`](./dev-strava-reset.ts) to reset Strava-derived KV
 * so OAuth and sync use the new app (restart dev after editing `.dev.vars`).
 */
export async function getStravaAppConfig(env: Env): Promise<StravaAppConfig | null> {
  const fromEnv =
    env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET
      ? { client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET }
      : null;

  if (prefersStravaFromEnv(env) && fromEnv) {
    return fromEnv;
  }

  const stored = await env.STRAVA_KV.get<StravaAppConfig>(KEY_STRAVA_APP, "json");
  if (stored && stored.client_id && stored.client_secret) return stored;

  if (fromEnv) return fromEnv;
  return null;
}

export async function setStravaAppConfig(env: Env, config: StravaAppConfig): Promise<void> {
  await env.STRAVA_KV.put(KEY_STRAVA_APP, JSON.stringify(config));
}

/**
 * Resolve (or lazily provision) the HMAC secret used to sign session cookies.
 *
 * If an operator set `SESSION_SECRET` via wrangler secrets, use that. Otherwise
 * generate a cryptographically random value on first access and persist it to
 * KV so subsequent requests can verify existing sessions.
 */
export async function getSessionSecret(env: Env): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;

  const existing = await env.STRAVA_KV.get(KEY_SESSION_SECRET);
  if (existing) return existing;

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await env.STRAVA_KV.put(KEY_SESSION_SECRET, secret);
  return secret;
}

/**
 * Derive the app's public origin. Prefers an explicit `APP_URL` when set,
 * otherwise falls back to the origin of the incoming request so the redirect
 * URI passed to Strava always matches wherever the Worker is actually
 * reachable (workers.dev subdomain, custom domain, or localhost).
 */
export function getAppUrl(env: Env, req: Request): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/+$/, "");
  return new URL(req.url).origin;
}

/** Extract the hostname portion of the app URL — this is what Strava calls the
 *  "Authorization Callback Domain" and is all we instruct the user to set. */
export function getCallbackDomain(env: Env, req: Request): string {
  return new URL(getAppUrl(env, req)).host;
}
