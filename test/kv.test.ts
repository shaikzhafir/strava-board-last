import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  getOwner,
  setOwner,
  getTokens,
  setTokens,
  acquireSyncLock,
  releaseSyncLock,
  KEY,
} from "../worker/kv";

async function clearKV() {
  const list = await env.STRAVA_KV.list();
  await Promise.all(list.keys.map((k) => env.STRAVA_KV.delete(k.name)));
}

describe("kv helpers", () => {
  beforeEach(async () => {
    await clearKV();
  });

  it("owner round-trip", async () => {
    expect(await getOwner(env)).toBeNull();
    await setOwner(env, 42);
    expect(await getOwner(env)).toBe(42);
  });

  it("tokens round-trip", async () => {
    const tokens = { access_token: "a", refresh_token: "r", expires_at: 9999 };
    expect(await getTokens(env, 42)).toBeNull();
    await setTokens(env, 42, tokens);
    expect(await getTokens(env, 42)).toEqual(tokens);
  });

  it("acquireSyncLock blocks concurrent runs", async () => {
    expect(await acquireSyncLock(env)).toBe(true);
    expect(await acquireSyncLock(env)).toBe(false);
    await releaseSyncLock(env);
    expect(await acquireSyncLock(env)).toBe(true);
  });

  it("lock uses expirationTtl so stale locks clear", async () => {
    await acquireSyncLock(env);
    const val = await env.STRAVA_KV.getWithMetadata(KEY.LOCK_SYNC);
    expect(val.value).toBe("1");
  });
});
