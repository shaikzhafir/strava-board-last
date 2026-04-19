import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { setOwner, setTokens } from "../worker/kv";
import { sign } from "../worker/session";

const OWNER = 5555;
const TEST_SECRET = "test-session-secret-please-change";

async function clearKV() {
  const list = await env.STRAVA_KV.list();
  await Promise.all(list.keys.map((k) => env.STRAVA_KV.delete(k.name)));
}

async function registerTestAdmin(): Promise<string> {
  const res = await SELF.fetch("http://localhost/api/admin/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "octocat", password: "correct horse battery staple" }),
  });
  if (res.status !== 200) throw new Error(`admin register failed (${res.status})`);
  const match = res.headers.get("Set-Cookie")!.match(/admin_sid=([^;]+)/);
  return `admin_sid=${match![1]}`;
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

describe("worker HTTP router", () => {
  beforeEach(async () => {
    await clearKV();
  });

  it("GET /auth/strava/login 302s to strava.com with client_id+redirect (admin authed, pre-claim)", async () => {
    const cookie = await registerTestAdmin();
    const res = await SELF.fetch("http://localhost/auth/strava/login", {
      redirect: "manual",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location")!;
    expect(loc).toContain("https://www.strava.com/oauth/authorize");
    expect(loc).toContain("client_id=test-client-id");
    expect(loc).toContain("redirect_uri=");
    expect(loc).toContain("scope=read%2Cactivity%3Aread_all");
  });

  it("GET /auth/strava/login returns 401 pre-claim when no admin is registered", async () => {
    const res = await SELF.fetch("http://localhost/auth/strava/login", { redirect: "manual" });
    expect(res.status).toBe(401);
  });

  it("GET /auth/strava/login returns 401 pre-claim when admin exists but caller isn't authed", async () => {
    await registerTestAdmin();
    const res = await SELF.fetch("http://localhost/auth/strava/login", { redirect: "manual" });
    expect(res.status).toBe(401);
  });

  it("GET /auth/strava/login skips the admin gate once the instance is claimed", async () => {
    await setOwner(env, OWNER);
    const res = await SELF.fetch("http://localhost/auth/strava/login", { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  it("GET /api/me returns nulls before any sync", async () => {
    const res = await SELF.fetch("http://localhost/api/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { athlete: unknown; lastSyncedAt: unknown };
    expect(body.athlete).toBeNull();
    expect(body.lastSyncedAt).toBeNull();
  });

  it("GET /api/stats returns null when no cache", async () => {
    const res = await SELF.fetch("http://localhost/api/stats");
    expect(await res.json()).toBeNull();
  });

  it("POST /api/sync without cookie returns 401", async () => {
    const res = await SELF.fetch("http://localhost/api/sync", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /api/sync with a valid owner cookie returns 202", async () => {
    await setOwner(env, OWNER);
    await setTokens(env, OWNER, {
      access_token: "a",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    // Stub outbound Strava calls from the fire-and-forget sync.
    fetchMock
      .get("https://www.strava.com")
      .intercept({ path: (p) => p.startsWith("/api/v3/"), method: "GET" })
      .reply(200, "{}")
      .persist();
    const sid = await sign(
      { athlete_id: OWNER, iat: Math.floor(Date.now() / 1000) },
      TEST_SECRET,
    );
    const res = await SELF.fetch("http://localhost/api/sync", {
      method: "POST",
      headers: { Cookie: `sid=${sid}` },
    });
    expect(res.status).toBe(202);
  });

  it("POST /api/sync rejects a valid cookie for a non-owner athlete", async () => {
    await setOwner(env, OWNER);
    const sid = await sign(
      { athlete_id: 9999, iat: Math.floor(Date.now() / 1000) },
      TEST_SECRET,
    );
    const res = await SELF.fetch("http://localhost/api/sync", {
      method: "POST",
      headers: { Cookie: `sid=${sid}` },
    });
    expect(res.status).toBe(401);
  });

  it("POST /auth/logout clears sid cookie", async () => {
    const res = await SELF.fetch("http://localhost/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/sid=;.*Max-Age=0/);
  });
});

