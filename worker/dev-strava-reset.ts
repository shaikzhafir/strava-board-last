import type { Env } from "./types";
import { prefersStravaFromEnv } from "./config";
import { KEY } from "./kv";

/** KV stores SHA-256 hex of `client_id\0client_secret` whenever `STRAVA_PREFER_DEV_VARS` is on. */
const FINGERPRINT_KEY = "config:dev_strava_app_fingerprint";

async function fingerprintForCredentials(clientId: string, clientSecret: string): Promise<string> {
  const raw = `${clientId}\0${clientSecret}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deleteKeysWithPrefix(kv: KVNamespace, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const res = await kv.list({ prefix, cursor });
    await Promise.all(res.keys.map((k) => kv.delete(k.name)));
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
}

/**
 * When `STRAVA_PREFER_DEV_VARS` is set, compare the current env Client ID/Secret
 * to the last-seen fingerprint. If they differ, clear owner, OAuth tokens, Strava
 * caches, and wizard-stored app config so the next OAuth + sync uses the new app.
 *
 * Call from the HTTP `fetch` handler and from `scheduled` so cron does not run
 * with stale tokens after a credential switch.
 */
export async function reconcileDevStravaAppSwitch(env: Env): Promise<void> {
  if (!prefersStravaFromEnv(env)) return;

  const clientId = env.STRAVA_CLIENT_ID?.trim();
  const clientSecret = env.STRAVA_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return;

  const fp = await fingerprintForCredentials(clientId, clientSecret);
  const prev = await env.STRAVA_KV.get(FINGERPRINT_KEY);
  if (prev === fp) return;

  await clearStravaDerivedStateForAppSwitch(env);
  await env.STRAVA_KV.put(FINGERPRINT_KEY, fp);
}

async function clearStravaDerivedStateForAppSwitch(env: Env): Promise<void> {
  const kv = env.STRAVA_KV;
  await deleteKeysWithPrefix(kv, "tokens:");
  await Promise.all([
    kv.delete(KEY.OWNER),
    kv.delete(KEY.CACHE_ATHLETE),
    kv.delete(KEY.CACHE_STATS),
    kv.delete(KEY.CACHE_DAILY),
    kv.delete(KEY.LAST_SYNCED_AT),
    kv.delete(KEY.LOCK_SYNC),
    kv.delete(KEY.STRAVA_APP),
  ]);
}
