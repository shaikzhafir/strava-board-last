---
name: strava-api
description: >-
  Extends this Strava board with new API-backed data and React visualizations.
  Covers Worker sync vs on-demand Strava calls, KV caching, authenticated routes,
  rate limits, and tests. Use when adding charts, maps, activity detail, streams,
  segments, or any feature that reads Strava data in this repository.
---

# Strava API extensions (strava-board)

## Architecture rules (do not break these)

- **Public board routes** (`/api/me`, `/api/stats`, `/api/daily-activity`, static activity payloads, etc.) must **read KV only** — no live Strava calls. Anonymous users can hit them.
- **Strava is called only** from OAuth/token flows and from **sync** (cron) unless you deliberately add a **separate owner-gated** route for on-demand data.
- **Every Strava REST call** must go through `stravaFetch` in `worker/strava.ts` so calls are logged as `event=strava_api_call`.

## Scopes

OAuth scopes are defined in `worker/auth.ts` (currently `read,activity:read_all`). Adding uploads, etc. requires new scopes and user re-consent.

## Two wiring patterns

### Path A — bake into scheduled sync

For small, always-on payloads (gear list, athlete zones, extra summary fields):

1. Add types in `worker/types.ts`.
2. Fetch in `worker/sync.ts` (often alongside existing `Promise.all` work).
3. Persist in `worker/kv.ts` (new key constant + read/write helpers as needed).
4. Expose via a new `GET /api/...` in `worker/index.ts` that **reads KV only**.
5. Add a client fetcher in `src/lib/api.ts` and a component under `src/components/`.
6. Update `test/sync.test.ts` and `test/worker.test.ts`.

### Path B — on-demand (streams, heavy per-activity data)

1. Add a route in `worker/index.ts` that uses `requireOwner` (or equivalent) so strangers cannot burn the app rate limit.
2. Call `stravaFetch` inside that handler. Optionally cache responses in KV with a TTL keyed by resource id.
3. Call the new route from the UI only when needed (e.g. user opens an activity).

## Rate limits and cost

Per Strava app: **200 requests / 15 minutes** and **2,000 / day** (unless you have a different approved tier). Prefer caching, pagination caps, and webhooks over naive polling. Do not fetch streams for every activity in a list — fetch when the user drills in.

## Repository reference

For endpoint ideas (streams, segments, routes, webhooks), OAuth notes, and extended examples, read [docs/strava-skills.md](../../docs/strava-skills.md) in this repo.

Official reference: [Strava API reference](https://developers.strava.com/docs/reference/).
