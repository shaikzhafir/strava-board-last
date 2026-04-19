import { describe, it, expect, vi } from "vitest";
import { getStravaAppConfig } from "../worker/config";
import type { Env } from "../worker/types";

function mockEnv(
  opts: {
    kvStored?: { client_id: string; client_secret: string } | null;
  } & Partial<Pick<Env, "STRAVA_CLIENT_ID" | "STRAVA_CLIENT_SECRET" | "STRAVA_PREFER_DEV_VARS">>,
): Env {
  const stored = opts.kvStored ?? null;
  return {
    STRAVA_KV: {
      get: vi.fn(async (key: string, format?: string) => {
        if (key !== "config:strava_app") return null;
        if (!stored) return null;
        return format === "json" ? stored : JSON.stringify(stored);
      }),
    } as unknown as KVNamespace,
    ASSETS: {} as Fetcher,
    STRAVA_CLIENT_ID: opts.STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET: opts.STRAVA_CLIENT_SECRET,
    STRAVA_PREFER_DEV_VARS: opts.STRAVA_PREFER_DEV_VARS,
  };
}

describe("getStravaAppConfig", () => {
  it("prefers KV when STRAVA_PREFER_DEV_VARS is unset", async () => {
    const env = mockEnv({
      kvStored: { client_id: "kv-id", client_secret: "kv-secret" },
      STRAVA_CLIENT_ID: "env-id",
      STRAVA_CLIENT_SECRET: "b".repeat(40),
    });
    const cfg = await getStravaAppConfig(env);
    expect(cfg?.client_id).toBe("kv-id");
  });

  it("prefers env when STRAVA_PREFER_DEV_VARS is true", async () => {
    const env = mockEnv({
      kvStored: { client_id: "kv-id", client_secret: "kv-secret" },
      STRAVA_CLIENT_ID: "env-id",
      STRAVA_CLIENT_SECRET: "b".repeat(40),
      STRAVA_PREFER_DEV_VARS: "true",
    });
    const cfg = await getStravaAppConfig(env);
    expect(cfg?.client_id).toBe("env-id");
  });

  it("prefers env when STRAVA_PREFER_DEV_VARS is 1", async () => {
    const env = mockEnv({
      kvStored: { client_id: "kv-id", client_secret: "kv-secret" },
      STRAVA_CLIENT_ID: "env-id",
      STRAVA_CLIENT_SECRET: "b".repeat(40),
      STRAVA_PREFER_DEV_VARS: "1",
    });
    const cfg = await getStravaAppConfig(env);
    expect(cfg?.client_id).toBe("env-id");
  });

  it("falls back to KV when prefer flag set but env incomplete", async () => {
    const env = mockEnv({
      kvStored: { client_id: "kv-id", client_secret: "kv-secret" },
      STRAVA_CLIENT_ID: "env-id",
      STRAVA_PREFER_DEV_VARS: "true",
    });
    const cfg = await getStravaAppConfig(env);
    expect(cfg?.client_id).toBe("kv-id");
  });
});
