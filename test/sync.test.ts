import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { runSync, aggregateDaily } from "../worker/sync";
import { setOwner, setTokens, KEY } from "../worker/kv";
import type { StravaActivity } from "../worker/types";

const OWNER = 7777;

async function clearKV() {
  const list = await env.STRAVA_KV.list();
  await Promise.all(list.keys.map((k) => env.STRAVA_KV.delete(k.name)));
}

const athleteBody = {
  id: OWNER,
  firstname: "Test",
  lastname: "User",
  profile: "",
  profile_medium: "",
};
const activitiesBody = [
  {
    id: 1,
    name: "Morning Run",
    type: "Run",
    sport_type: "Run",
    start_date: "2024-01-01T08:00:00Z",
    start_date_local: "2024-01-01T08:00:00",
    distance: 5000,
    moving_time: 1500,
    elapsed_time: 1500,
    total_elevation_gain: 10,
    average_speed: 3.33,
    max_speed: 4.0,
    map: { summary_polyline: "abc" },
  },
];
const statsBody = {
  recent_run_totals: { count: 1, distance: 5000, moving_time: 1500, elevation_gain: 10 },
  recent_ride_totals: { count: 0, distance: 0, moving_time: 0, elevation_gain: 0 },
  recent_swim_totals: { count: 0, distance: 0, moving_time: 0, elevation_gain: 0 },
  ytd_run_totals: { count: 1, distance: 5000, moving_time: 1500, elevation_gain: 10 },
  ytd_ride_totals: { count: 0, distance: 0, moving_time: 0, elevation_gain: 0 },
  all_run_totals: { count: 1, distance: 5000, moving_time: 1500, elevation_gain: 10 },
  all_ride_totals: { count: 0, distance: 0, moving_time: 0, elevation_gain: 0 },
};

function stubStravaApi() {
  const pool = fetchMock.get("https://www.strava.com");
  pool.intercept({ path: "/api/v3/athlete", method: "GET" }).reply(200, JSON.stringify(athleteBody));
  pool
    .intercept({
      method: "GET",
      path: (p) => p.startsWith("/api/v3/athlete/activities"),
    })
    .reply(200, JSON.stringify(activitiesBody));
  pool
    .intercept({
      method: "GET",
      path: (p) => p.startsWith("/api/v3/athletes/") && p.endsWith("/stats"),
    })
    .reply(200, JSON.stringify(statsBody));
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

describe("runSync", () => {
  beforeEach(async () => {
    await clearKV();
  });

  it("returns no_owner when KV has no owner", async () => {
    const r = await runSync(env);
    expect(r).toEqual({ ok: false, reason: "no_owner" });
  });

  it("returns no_tokens when owner is set but tokens missing", async () => {
    await setOwner(env, OWNER);
    const r = await runSync(env);
    expect(r).toEqual({ ok: false, reason: "no_tokens" });
  });

  it("populates KV cache on success", async () => {
    await setOwner(env, OWNER);
    await setTokens(env, OWNER, {
      access_token: "fresh",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    stubStravaApi();

    const r = await runSync(env);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.activities).toBe(1);

    expect(await env.STRAVA_KV.get(KEY.CACHE_ATHLETE, "json")).toMatchObject({ id: OWNER });
    expect(await env.STRAVA_KV.get(KEY.LAST_SYNCED_AT)).not.toBeNull();
  });

  it("refuses to run while lock is held", async () => {
    await setOwner(env, OWNER);
    await setTokens(env, OWNER, {
      access_token: "fresh",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    await env.STRAVA_KV.put(KEY.LOCK_SYNC, "1", { expirationTtl: 60 });
    const r = await runSync(env);
    expect(r).toEqual({ ok: false, reason: "locked" });
  });

  it("releases lock on success", async () => {
    await setOwner(env, OWNER);
    await setTokens(env, OWNER, {
      access_token: "fresh",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    stubStravaApi();
    await runSync(env);
    expect(await env.STRAVA_KV.get(KEY.LOCK_SYNC)).toBeNull();
  });

  it("writes a daily-activity aggregate to KV on success", async () => {
    await setOwner(env, OWNER);
    await setTokens(env, OWNER, {
      access_token: "fresh",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    stubStravaApi();
    await runSync(env);
    const daily = await env.STRAVA_KV.get<{
      byDate: Record<string, { count: number; distance_m: number }>;
      years: number[];
    }>(KEY.CACHE_DAILY, "json");
    expect(daily).not.toBeNull();
    expect(daily!.byDate["2024-01-01"]).toEqual({ count: 1, distance_m: 5000 });
    expect(daily!.years).toEqual([2024]);
  });
});

describe("aggregateDaily", () => {
  function act(start_date_local: string, distance: number): StravaActivity {
    return {
      id: Math.random(),
      name: "",
      type: "Run",
      sport_type: "Run",
      start_date: start_date_local + "Z",
      start_date_local,
      distance,
      moving_time: 0,
      elapsed_time: 0,
      total_elevation_gain: 0,
      average_speed: 0,
      max_speed: 0,
      map: { summary_polyline: null },
    };
  }

  it("buckets activities by local date and sums distance", () => {
    const result = aggregateDaily([
      act("2025-03-14T07:00:00", 5000),
      act("2025-03-14T19:30:00", 3000),
      act("2025-03-15T08:00:00", 10000),
      act("2024-12-31T23:00:00", 1500),
    ]);
    expect(result.byDate["2025-03-14"]).toEqual({ count: 2, distance_m: 8000 });
    expect(result.byDate["2025-03-15"]).toEqual({ count: 1, distance_m: 10000 });
    expect(result.byDate["2024-12-31"]).toEqual({ count: 1, distance_m: 1500 });
    expect(result.years).toEqual([2024, 2025]);
  });

  it("skips activities with no local date", () => {
    const result = aggregateDaily([
      { ...act("2025-01-01T00:00:00", 1000), start_date_local: "" } as StravaActivity,
      act("2025-01-02T00:00:00", 2000),
    ]);
    expect(result.byDate["2025-01-02"]).toEqual({ count: 1, distance_m: 2000 });
    expect(Object.keys(result.byDate)).toEqual(["2025-01-02"]);
  });
});
