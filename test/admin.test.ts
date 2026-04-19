import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { KEY } from "../worker/kv";

async function clearKV() {
  const list = await env.STRAVA_KV.list();
  await Promise.all(list.keys.map((k) => env.STRAVA_KV.delete(k.name)));
}

async function register(
  body: Record<string, unknown>,
): Promise<{ status: number; cookie: string | null; body: Record<string, unknown> }> {
  const res = await SELF.fetch("http://localhost/api/admin/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const setCookie = res.headers.get("Set-Cookie");
  return { status: res.status, cookie: setCookie, body: parsed };
}

async function login(
  body: Record<string, unknown>,
  ip?: string,
): Promise<{
  status: number;
  cookie: string | null;
  body: Record<string, unknown>;
  retryAfter: string | null;
}> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  const res = await SELF.fetch("http://localhost/api/admin/login", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    status: res.status,
    cookie: res.headers.get("Set-Cookie"),
    body: parsed,
    retryAfter: res.headers.get("Retry-After"),
  };
}

describe("admin auth", () => {
  beforeEach(async () => {
    await clearKV();
  });

  it("POST /api/admin/register succeeds the first time and sets an HttpOnly cookie", async () => {
    const r = await register({ username: "octocat", password: "correct horse battery staple" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, username: "octocat" });
    expect(r.cookie).toMatch(/admin_sid=[^;]+/);
    expect(r.cookie).toContain("HttpOnly");
    expect(r.cookie).toContain("SameSite=Lax");
  });

  it("register persists a PBKDF2 hash — not the plaintext password", async () => {
    const password = "correct horse battery staple";
    await register({ username: "octocat", password });
    const stored = (await env.STRAVA_KV.get<{
      username: string;
      salt: string;
      hash: string;
      iterations: number;
    }>(KEY.ADMIN, "json"))!;
    expect(stored.username).toBe("octocat");
    expect(stored.salt.length).toBeGreaterThan(10);
    expect(stored.hash.length).toBeGreaterThan(10);
    expect(stored.iterations).toBe(10_000);
    // Plaintext must not appear anywhere in the stored record.
    expect(JSON.stringify(stored)).not.toContain(password);
  });

  it("register lowercases the username (GitHub is case-insensitive)", async () => {
    const r = await register({ username: "OctoCat", password: "correct horse battery staple" });
    expect(r.status).toBe(200);
    expect(r.body.username).toBe("octocat");
  });

  it("register rejects invalid GitHub usernames", async () => {
    for (const bad of ["", "-lead-dash", "trail-dash-", "has space", "two--hyphens", "x".repeat(40)]) {
      const r = await register({ username: bad, password: "correct horse battery staple" });
      expect(r.status).toBe(400);
    }
  });

  it("register rejects passwords shorter than 8 characters", async () => {
    const r = await register({ username: "octocat", password: "short" });
    expect(r.status).toBe(400);
  });

  it("register accepts an 8-character password", async () => {
    const r = await register({ username: "shortpwok", password: "12345678" });
    expect(r.status).toBe(200);
  });

  it("register refuses once an admin already exists", async () => {
    await register({ username: "octocat", password: "correct horse battery staple" });
    const r = await register({ username: "mallory", password: "another long password abc" });
    expect(r.status).toBe(409);
  });

  it("login with correct creds returns a cookie", async () => {
    await register({ username: "octocat", password: "correct horse battery staple" });
    const r = await login({ username: "octocat", password: "correct horse battery staple" });
    expect(r.status).toBe(200);
    expect(r.cookie).toMatch(/admin_sid=[^;]+/);
  });

  it("login is case-insensitive on username", async () => {
    await register({ username: "octocat", password: "correct horse battery staple" });
    const r = await login({ username: "OCTOCAT", password: "correct horse battery staple" });
    expect(r.status).toBe(200);
  });

  it("login with wrong password returns 401", async () => {
    await register({ username: "octocat", password: "correct horse battery staple" });
    const r = await login({ username: "octocat", password: "wrong password attempt here" });
    expect(r.status).toBe(401);
  });

  it("login with unknown username returns 401 (not 404, to avoid enumeration)", async () => {
    await register({ username: "octocat", password: "correct horse battery staple" });
    const r = await login({ username: "mallory", password: "correct horse battery staple" });
    expect(r.status).toBe(401);
  });

  it("login before any admin is registered returns 404", async () => {
    const r = await login({ username: "octocat", password: "correct horse battery staple" });
    expect(r.status).toBe(404);
  });

  it("POST /api/admin/logout clears the admin_sid cookie", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/logout", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/admin_sid=;.*Max-Age=0/);
  });

  it("login rate-limits after 10 failed attempts from the same IP", async () => {
    await register({ username: "octocat", password: "correct horse battery staple" });
    for (let i = 0; i < 10; i++) {
      const r = await login({ username: "octocat", password: "wrong password attempt" }, "10.0.0.1");
      expect(r.status).toBe(401);
    }
    const blocked = await login(
      { username: "octocat", password: "wrong password attempt" },
      "10.0.0.1",
    );
    expect(blocked.status).toBe(429);
    expect(blocked.retryAfter).toBe("900");
    // Even correct credentials are blocked while the limit is in effect.
    const stillBlocked = await login(
      { username: "octocat", password: "correct horse battery staple" },
      "10.0.0.1",
    );
    expect(stillBlocked.status).toBe(429);
  });

  it("a successful login clears the rate-limit counter", async () => {
    await register({ username: "octocat", password: "correct horse battery staple" });
    for (let i = 0; i < 5; i++) {
      const r = await login({ username: "octocat", password: "wrong password attempt" }, "10.0.0.2");
      expect(r.status).toBe(401);
    }
    const ok = await login(
      { username: "octocat", password: "correct horse battery staple" },
      "10.0.0.2",
    );
    expect(ok.status).toBe(200);
    for (let i = 0; i < 10; i++) {
      const r = await login({ username: "octocat", password: "wrong password attempt" }, "10.0.0.2");
      expect(r.status).toBe(401);
    }
  });

  it("rate limits are bucketed per IP", async () => {
    await register({ username: "octocat", password: "correct horse battery staple" });
    for (let i = 0; i < 10; i++) {
      await login({ username: "octocat", password: "wrong password attempt" }, "10.0.0.3");
    }
    const blockedA = await login(
      { username: "octocat", password: "wrong password attempt" },
      "10.0.0.3",
    );
    expect(blockedA.status).toBe(429);
    const freshB = await login(
      { username: "octocat", password: "wrong password attempt" },
      "10.0.0.4",
    );
    expect(freshB.status).toBe(401);
  });
});
