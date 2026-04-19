import { describe, it, expect, vi } from "vitest";
import { reconcileDevStravaAppSwitch } from "../worker/dev-strava-reset";
import type { Env } from "../worker/types";

function createMockKV(initial: Map<string, string>) {
  const store = initial;
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (opts: { prefix: string; cursor?: string }) => {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(opts.prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    }),
  } as unknown as KVNamespace;
}

describe("reconcileDevStravaAppSwitch", () => {
  it("does nothing when STRAVA_PREFER_DEV_VARS is unset", async () => {
    const store = new Map<string, string>([["owner:athlete_id", "1"]]);
    const kv = createMockKV(store);
    const env = {
      STRAVA_KV: kv,
      STRAVA_CLIENT_ID: "111",
      STRAVA_CLIENT_SECRET: "a".repeat(40),
      ASSETS: {} as Fetcher,
    } as Env;

    await reconcileDevStravaAppSwitch(env);
    expect(store.get("owner:athlete_id")).toBe("1");
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("clears Strava state and stores fingerprint when prefer is on and fingerprint is new", async () => {
    const store = new Map<string, string>([
      ["owner:athlete_id", "999"],
      ["tokens:999", "{}"],
      ["cache:athlete", "{}"],
    ]);
    const kv = createMockKV(store);
    const env = {
      STRAVA_KV: kv,
      STRAVA_CLIENT_ID: "222",
      STRAVA_CLIENT_SECRET: "b".repeat(40),
      STRAVA_PREFER_DEV_VARS: "true",
      ASSETS: {} as Fetcher,
    } as Env;

    await reconcileDevStravaAppSwitch(env);

    expect(store.has("owner:athlete_id")).toBe(false);
    expect(store.has("tokens:999")).toBe(false);
    expect(store.has("cache:athlete")).toBe(false);
    expect(store.has("config:dev_strava_app_fingerprint")).toBe(true);
  });

  it("skips clear when fingerprint matches", async () => {
    const id = "222";
    const secret = "b".repeat(40);
    const raw = `${id}\0${secret}`;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    const fp = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

    const store = new Map<string, string>([
      ["owner:athlete_id", "999"],
      ["config:dev_strava_app_fingerprint", fp],
    ]);
    const kv = createMockKV(store);
    const env = {
      STRAVA_KV: kv,
      STRAVA_CLIENT_ID: id,
      STRAVA_CLIENT_SECRET: secret,
      STRAVA_PREFER_DEV_VARS: "true",
      ASSETS: {} as Fetcher,
    } as Env;

    await reconcileDevStravaAppSwitch(env);
    expect(store.get("owner:athlete_id")).toBe("999");
  });
});
