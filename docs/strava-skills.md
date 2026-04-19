# Strava API skills

Catalog of Strava endpoints you can plug into this board if you want to
visualize more than the default summary + heatmap. The current implementation
is intentionally minimal (see "Currently used" below) so that the daily sync
stays well under Strava's rate limits.

## Scopes we request

OAuth scope string (set in `worker/auth.ts`):

```
read,activity:read_all
```

| Scope | Grants |
| --- | --- |
| `read` | Public profile + public segments/routes |
| `activity:read_all` | All your activities, including private + activities of friends you can see |

If you add a skill that needs more access (e.g. uploading), request the
appropriate additional scope and re-authorize. Strava only adds new scopes on
re-consent — old tokens won't suddenly gain them.

## Rate limits

Strava enforces two rolling limits per app (not per user):

- **200 requests / 15 minutes**
- **2,000 requests / day**

A new "non-upload" tier exists too (1000 / 15 min, 10000 / day) for read-only
apps — you have to apply for it. Don't assume you have it.

Every outbound call from this Worker logs a structured line:

```json
{"event":"strava_api_call","endpoint":"/athlete/activities?...","method":"GET","status":200,"ms":342,"kind":"api"}
```

In Cloudflare's Workers Logs (or `wrangler tail`), filter on
`event=strava_api_call` to count what you're spending.

A typical incremental sync is:

- 1× `/athlete`
- 1× `/athlete/activities?after=…` (rewinds 24h, almost always one page)
- 1× `/athletes/{id}/stats`
- 0–1× `/oauth/token?grant=refresh` (only when the access token is within 60s of expiry)

A first-time backfill walks `/athlete/activities` until a short page is
returned. With `per_page=200` and `MAX_PAGES=30` (see `worker/sync.ts`), the
worst case is ~30 calls for two years of dense history.

## Currently used

| Endpoint | Where | Why |
| --- | --- | --- |
| `POST /oauth/token` | `worker/strava.ts` (`exchangeCode`, `refreshTokens`) | OAuth code exchange + access token refresh |
| `GET /athlete` | `worker/sync.ts` | Profile (name, avatar, location) for the header |
| `GET /athlete/activities?per_page=200&page=N&after=UNIX` | `worker/sync.ts` | Paginated activity list, fed into the heatmap aggregator |
| `GET /athletes/{id}/stats` | `worker/sync.ts` | Pre-aggregated recent / YTD / all-time totals for the Summary cards |

Everything served from `/api/*` is a re-read of cached KV state. The frontend
never calls Strava directly.

## Other endpoints worth wiring up

These are read-only endpoints that fit the existing `stravaFetch` helper. None
of them are wired today — they're here so you know what's possible.

### Activity detail & streams

- `GET /activities/{id}` — full detail for a single activity (description, gear, splits, segment efforts).
- `GET /activities/{id}/streams?keys=time,distance,heartrate,altitude,latlng,velocity_smooth,cadence,watts,temp,grade_smooth&key_by_type=true` — the time-series data behind a single activity. Useful for plotting a single ride/run, drawing the route on a map, or computing custom HR/power zones.
- `GET /activities/{id}/laps` — auto/manual laps for an activity.
- `GET /activities/{id}/zones` — heart-rate / power zones for one activity.
- `GET /activities/{id}/comments`, `GET /activities/{id}/kudos` — social side.

> Streams are heavy. A long ride can be 10k+ samples. Don't fetch streams for
> every activity in the heatmap — fetch on demand when the user clicks a cell.

### Segments

- `GET /segments/starred` — segments you've starred.
- `GET /segments/{id}` — leaderboard-free segment metadata.
- `GET /segments/{id}/all_efforts` — all your efforts on one segment, good for "am I getting faster on the local hill?" charts.
- `GET /segments/explore?bounds=…&activity_type=…` — find new segments in a bounding box.

### Routes & gear

- `GET /athletes/{id}/routes` — routes you've saved/published.
- `GET /routes/{id}` and `GET /routes/{id}/streams` — route polyline + elevation profile for an "upcoming rides" planner.
- `GET /gear/{id}` — bike/shoe metadata. Activities reference `gear_id`; resolve once and cache to count distance per pair of shoes.

### Athlete / zones

- `GET /athlete/zones` — your heart-rate and power zones.
- `GET /athletes/{id}/stats` — already used.
- `GET /athlete/clubs` — your clubs.

### Webhooks (push, not poll)

- `POST /push_subscriptions` — register a webhook so Strava POSTs you when an activity is created/updated/deleted.

If you switch to webhooks you can largely stop polling `/athlete/activities`,
which is the single biggest source of API spend. The trade-off is more moving
parts: a public webhook URL, a verification handshake, and replay tolerance.

## How to wire a new endpoint

The shape follows the existing two paths through the codebase. Pick one
depending on whether you want the data baked into the daily sync or fetched on
demand.

### Path A — bake into the cached sync (best for low-volume, "show always" data)

1. **Type it** in `worker/types.ts`, e.g. add `StravaGear`.
2. **Fetch it** in `worker/sync.ts` inside the `Promise.all` block:
   ```ts
   const [athlete, fresh, stats, gear] = await Promise.all([
     stravaFetch<StravaAthlete>(env, owner, "/athlete"),
     fetchActivitiesSince(env, owner, afterUnix),
     stravaFetch<StravaStats>(env, owner, `/athletes/${owner}/stats`),
     stravaFetch<StravaGear>(env, owner, `/gear/${someId}`),
   ]);
   ```
3. **Cache it** under a new `KEY.CACHE_GEAR` in `worker/kv.ts`, write it
   alongside the others in `runSync`.
4. **Expose it** as a new `GET /api/gear` route in `worker/index.ts` that
   returns the cached value (no live Strava call).
5. **Consume it** in `src/lib/api.ts` (add a fetcher) and in a React component
   under `src/components/`.

Test surface to update:

- `test/sync.test.ts` — assert the new KV key is populated.
- `test/worker.test.ts` — assert the new `/api/*` route returns the cached value.

### Path B — on-demand (best for heavy data like streams)

Skip the sync. Add a route handler in `worker/index.ts` that calls
`stravaFetch` directly inside the request, but **gate it on `requireOwner`**
so randoms can't burn your rate limit:

```ts
if (pathname.startsWith("/api/activities/") && pathname.endsWith("/streams")) {
  const owner = await requireOwner(req, env);
  if (!owner) return json({ error: "unauthorized" }, { status: 401 });
  const id = pathname.split("/")[3];
  const streams = await stravaFetch(env, owner, `/activities/${id}/streams?keys=time,heartrate,altitude&key_by_type=true`);
  return json(streams);
}
```

Consider stashing the response in KV with a long TTL (`expirationTtl: 86400`)
keyed by activity id — historical activities don't change, so caching is free
correctness-wise and saves you from refetching when the user revisits.

### Things to keep in mind

- **Always go through `stravaFetch`** so calls show up in the structured log.
- **Token refresh is automatic** — `getAccessToken` in `worker/strava.ts` refreshes if `expires_at` is within 60 seconds.
- **Pagination** — most list endpoints take `per_page` (max 200) and `page` (1-indexed). Stop when a page returns fewer than `per_page` items.
- **`after` / `before`** are unix seconds, not ISO strings.
- **Don't run live Strava calls inside the public `/api/me`, `/api/stats`, `/api/daily-activity` routes.** Those are unauthenticated by design — they read KV only.
- **Webhooks > polling** if you outgrow the free rate limit tier. The plumbing is in `worker/index.ts`; just add a `/api/strava/webhook` POST handler.

## Reference

- API docs: <https://developers.strava.com/docs/reference/>
- Rate limits: <https://developers.strava.com/docs/rate-limits/>
- Webhook events: <https://developers.strava.com/docs/webhooks/>
