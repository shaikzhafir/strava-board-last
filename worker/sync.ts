import type {
  Env,
  StravaAthlete,
  StravaActivity,
  StravaStats,
  DailyActivity,
  DailyActivityMap,
} from "./types";
import { stravaFetch } from "./strava";
import {
  KEY,
  acquireSyncLock,
  releaseSyncLock,
  getCachedDaily,
  getOwner,
  getTokens,
} from "./kv";

const HISTORY_YEARS = 2;
const INCREMENTAL_REWIND_HOURS = 24;
const PAGE_SIZE = 200;
const MAX_PAGES = 30;

async function fetchActivitiesSince(
  env: Env,
  owner: number,
  afterUnix: number,
): Promise<StravaActivity[]> {
  const all: StravaActivity[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await stravaFetch<StravaActivity[]>(
      env,
      owner,
      `/athlete/activities?per_page=${PAGE_SIZE}&page=${page}&after=${afterUnix}`,
    );
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

export function aggregateDaily(activities: StravaActivity[]): DailyActivityMap {
  const byDate: Record<string, DailyActivity> = {};
  const years = new Set<number>();
  for (const a of activities) {
    if (!a.start_date_local) continue;
    const date = a.start_date_local.slice(0, 10);
    const year = Number(date.slice(0, 4));
    if (!Number.isFinite(year)) continue;
    years.add(year);
    const bucket = byDate[date] ?? { count: 0, distance_m: 0 };
    bucket.count += 1;
    bucket.distance_m += Math.round(a.distance ?? 0);
    byDate[date] = bucket;
  }
  return {
    byDate,
    years: [...years].sort((a, b) => a - b),
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Merge a freshly-fetched window of activities into the existing daily
 * aggregate. Any bucket at or after `cutoffDate` is dropped and recomputed
 * from `fresh`, so re-fetching the same window is idempotent.
 */
export function mergeDaily(
  existing: DailyActivityMap,
  fresh: StravaActivity[],
  cutoffDate: string,
): DailyActivityMap {
  const byDate: Record<string, DailyActivity> = {};
  for (const [d, bucket] of Object.entries(existing.byDate)) {
    if (d < cutoffDate) byDate[d] = bucket;
  }
  const years = new Set<number>(existing.years);
  for (const a of fresh) {
    if (!a.start_date_local) continue;
    const date = a.start_date_local.slice(0, 10);
    const year = Number(date.slice(0, 4));
    if (!Number.isFinite(year)) continue;
    years.add(year);
    const bucket = byDate[date] ?? { count: 0, distance_m: 0 };
    bucket.count += 1;
    bucket.distance_m += Math.round(a.distance ?? 0);
    byDate[date] = bucket;
  }
  return {
    byDate,
    years: [...years].sort((a, b) => a - b),
    syncedAt: new Date().toISOString(),
  };
}

function unixSecondsAgo(ms: number): number {
  return Math.floor((Date.now() - ms) / 1000);
}

function isoDateFromUnix(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

export type SyncResult =
  | { ok: true; activities: number; syncedAt: string; mode: "backfill" | "incremental" }
  | { ok: false; reason: "no_owner" | "no_tokens" | "locked" | "error"; message?: string };

export async function runSync(env: Env): Promise<SyncResult> {
  const owner = await getOwner(env);
  if (!owner) return { ok: false, reason: "no_owner" };
  const tokens = await getTokens(env, owner);
  if (!tokens) return { ok: false, reason: "no_tokens" };

  const gotLock = await acquireSyncLock(env);
  if (!gotLock) return { ok: false, reason: "locked" };

  try {
    const existing = await getCachedDaily(env);
    const mode: "backfill" | "incremental" = existing ? "incremental" : "backfill";
    const afterUnix =
      mode === "backfill"
        ? unixSecondsAgo(HISTORY_YEARS * 365 * 24 * 60 * 60 * 1000)
        : unixSecondsAgo(INCREMENTAL_REWIND_HOURS * 60 * 60 * 1000);
    const cutoffDate = isoDateFromUnix(afterUnix);

    const [athlete, fresh, stats] = await Promise.all([
      stravaFetch<StravaAthlete>(env, owner, "/athlete"),
      fetchActivitiesSince(env, owner, afterUnix),
      stravaFetch<StravaStats>(env, owner, `/athletes/${owner}/stats`),
    ]);

    const daily = existing ? mergeDaily(existing, fresh, cutoffDate) : aggregateDaily(fresh);

    await Promise.all([
      env.STRAVA_KV.put(KEY.CACHE_ATHLETE, JSON.stringify(athlete)),
      env.STRAVA_KV.put(KEY.CACHE_STATS, JSON.stringify(stats)),
      env.STRAVA_KV.put(KEY.CACHE_DAILY, JSON.stringify(daily)),
    ]);
    const syncedAt = new Date().toISOString();
    await env.STRAVA_KV.put(KEY.LAST_SYNCED_AT, syncedAt);
    return { ok: true, activities: fresh.length, syncedAt, mode };
  } catch (err) {
    return { ok: false, reason: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    await releaseSyncLock(env);
  }
}
