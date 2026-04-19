import type {
  Env,
  StravaAthlete,
  StravaStats,
  StravaTokens,
  DailyActivityMap,
} from "./types";

export const KEY = {
  OWNER: "owner:athlete_id",
  tokens: (id: number | string) => `tokens:${id}`,
  CACHE_ATHLETE: "cache:athlete",
  CACHE_STATS: "cache:stats",
  CACHE_DAILY: "cache:daily_activity",
  LAST_SYNCED_AT: "cache:lastSyncedAt",
  LOCK_SYNC: "lock:sync",
  STRAVA_APP: "config:strava_app",
  SESSION_SECRET: "config:session_secret",
  ADMIN: "config:admin",
  adminLoginAttempts: (ip: string) => `ratelimit:admin_login:${ip}`,
} as const;

export async function getOwner(env: Env): Promise<number | null> {
  const v = await env.STRAVA_KV.get(KEY.OWNER);
  return v ? Number(v) : null;
}

export async function setOwner(env: Env, id: number): Promise<void> {
  await env.STRAVA_KV.put(KEY.OWNER, String(id));
}

export async function getTokens(env: Env, id: number): Promise<StravaTokens | null> {
  return env.STRAVA_KV.get<StravaTokens>(KEY.tokens(id), "json");
}

export async function setTokens(env: Env, id: number, tokens: StravaTokens): Promise<void> {
  await env.STRAVA_KV.put(KEY.tokens(id), JSON.stringify(tokens));
}

export async function getCachedAthlete(env: Env): Promise<StravaAthlete | null> {
  return env.STRAVA_KV.get<StravaAthlete>(KEY.CACHE_ATHLETE, "json");
}

export async function getCachedStats(env: Env): Promise<StravaStats | null> {
  return env.STRAVA_KV.get<StravaStats>(KEY.CACHE_STATS, "json");
}

export async function getCachedDaily(env: Env): Promise<DailyActivityMap | null> {
  return env.STRAVA_KV.get<DailyActivityMap>(KEY.CACHE_DAILY, "json");
}

export async function getLastSyncedAt(env: Env): Promise<string | null> {
  return env.STRAVA_KV.get(KEY.LAST_SYNCED_AT);
}

export async function acquireSyncLock(env: Env): Promise<boolean> {
  const existing = await env.STRAVA_KV.get(KEY.LOCK_SYNC);
  if (existing) return false;
  await env.STRAVA_KV.put(KEY.LOCK_SYNC, "1", { expirationTtl: 60 });
  return true;
}

export async function releaseSyncLock(env: Env): Promise<void> {
  await env.STRAVA_KV.delete(KEY.LOCK_SYNC);
}

export async function getAdminLoginAttempts(env: Env, ip: string): Promise<number> {
  const v = await env.STRAVA_KV.get(KEY.adminLoginAttempts(ip));
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function incrAdminLoginAttempts(
  env: Env,
  ip: string,
  ttlSeconds: number,
): Promise<number> {
  const next = (await getAdminLoginAttempts(env, ip)) + 1;
  await env.STRAVA_KV.put(KEY.adminLoginAttempts(ip), String(next), {
    expirationTtl: ttlSeconds,
  });
  return next;
}

export async function clearAdminLoginAttempts(env: Env, ip: string): Promise<void> {
  await env.STRAVA_KV.delete(KEY.adminLoginAttempts(ip));
}
