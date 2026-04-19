import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { getAccessToken, stravaFetch } from "../worker/strava";
import { setTokens, getTokens } from "../worker/kv";

async function clearKV() {
  const list = await env.STRAVA_KV.list();
  await Promise.all(list.keys.map((k) => env.STRAVA_KV.delete(k.name)));
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

describe("getAccessToken refresh logic", () => {
  beforeEach(async () => {
    await clearKV();
  });

  it("returns stored token when not near expiry", async () => {
    await setTokens(env, 1, {
      access_token: "still-good",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    // No interceptor registered — any outbound fetch would error.
    const tok = await getAccessToken(env, 1);
    expect(tok).toBe("still-good");
  });

  it("refreshes and persists rotated refresh_token when near expiry", async () => {
    await setTokens(env, 1, {
      access_token: "expired",
      refresh_token: "old-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 10,
    });
    fetchMock
      .get("https://www.strava.com")
      .intercept({ path: "/oauth/token", method: "POST" })
      .reply(
        200,
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      );

    const tok = await getAccessToken(env, 1);
    expect(tok).toBe("new-access");
    const stored = await getTokens(env, 1);
    expect(stored?.refresh_token).toBe("new-refresh");
    expect(stored?.access_token).toBe("new-access");
  });

  it("stravaFetch attaches Bearer token", async () => {
    await setTokens(env, 1, {
      access_token: "bearer-abc",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    let sawAuth: string | undefined;
    fetchMock
      .get("https://www.strava.com")
      .intercept({ path: "/api/v3/athlete", method: "GET" })
      .reply((opts) => {
        const headers = opts.headers;
        sawAuth = Array.isArray(headers)
          ? undefined
          : (headers as Record<string, string>)?.authorization ??
            (headers as Record<string, string>)?.Authorization;
        return { statusCode: 200, data: JSON.stringify({ ok: true }) };
      });
    await stravaFetch(env, 1, "/athlete");
    expect(sawAuth).toBe("Bearer bearer-abc");
  });

  it("throws when no tokens stored", async () => {
    await expect(getAccessToken(env, 999)).rejects.toThrow(/No tokens/);
  });
});
