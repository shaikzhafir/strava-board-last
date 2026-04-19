import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { getOwner, getTokens, setOwner } from "../worker/kv";

async function clearKV() {
  const list = await env.STRAVA_KV.list();
  await Promise.all(list.keys.map((k) => env.STRAVA_KV.delete(k.name)));
}

function stubTokenExchange(athleteId: number) {
  const pool = fetchMock.get("https://www.strava.com");
  pool
    .intercept({ path: "/oauth/token", method: "POST" })
    .reply(
      200,
      JSON.stringify({
        access_token: "access-123",
        refresh_token: "refresh-456",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        athlete: { id: athleteId, firstname: "T", lastname: "U" },
      }),
    );
  // The post-callback runSync fires and hits these — return empty so it fails quickly and silently.
  pool.intercept({ path: (p) => p.startsWith("/api/v3/"), method: "GET" }).reply(200, "{}").persist();
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

describe("OAuth callback", () => {
  beforeEach(async () => {
    await clearKV();
  });

  it("first login claims ownership and sets sid cookie", async () => {
    stubTokenExchange(111);
    const res = await SELF.fetch("http://localhost/auth/strava/callback?code=xyz", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Set-Cookie")).toMatch(/sid=[^;]+/);
    expect(await getOwner(env)).toBe(111);
    const tokens = await getTokens(env, 111);
    expect(tokens?.access_token).toBe("access-123");
    expect(tokens?.refresh_token).toBe("refresh-456");
  });

  it("second login with a different athlete id is rejected", async () => {
    await setOwner(env, 111);
    stubTokenExchange(222);
    const res = await SELF.fetch("http://localhost/auth/strava/callback?code=xyz", {
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(await getOwner(env)).toBe(111);
  });

  it("same-athlete re-login updates tokens but keeps owner", async () => {
    await setOwner(env, 333);
    stubTokenExchange(333);
    const res = await SELF.fetch("http://localhost/auth/strava/callback?code=new", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(await getOwner(env)).toBe(333);
    const tokens = await getTokens(env, 333);
    expect(tokens?.access_token).toBe("access-123");
  });

  it("missing code returns 400", async () => {
    const res = await SELF.fetch("http://localhost/auth/strava/callback", { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("strava-reported error returns 400", async () => {
    const res = await SELF.fetch(
      "http://localhost/auth/strava/callback?error=access_denied",
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });
});
