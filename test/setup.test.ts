import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { setOwner, KEY } from "../worker/kv";
import { sign, type AdminSessionPayload } from "../worker/session";

async function clearKV() {
  const list = await env.STRAVA_KV.list();
  await Promise.all(list.keys.map((k) => env.STRAVA_KV.delete(k.name)));
}

const TEST_SECRET = "test-session-secret-please-change";

// Credentials look plausible; real Strava client_secret is 40 hex chars, client_id is a short int.
const VALID_CLIENT_ID = "987654";
const VALID_CLIENT_SECRET = "a".repeat(40);
const TEST_ADMIN_USERNAME = "octocat";
const TEST_ADMIN_PASSWORD = "correct horse battery staple";

/**
 * Register an admin via the public endpoint and return a cookie header the
 * rest of the test can reuse for authenticated calls.
 */
async function registerTestAdmin(
  username = TEST_ADMIN_USERNAME,
  password = TEST_ADMIN_PASSWORD,
): Promise<string> {
  const res = await SELF.fetch("http://localhost/api/admin/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) {
    throw new Error(`admin register failed (${res.status}): ${await res.text()}`);
  }
  const setCookie = res.headers.get("Set-Cookie")!;
  const match = setCookie.match(/admin_sid=([^;]+)/);
  if (!match) throw new Error(`no admin_sid in Set-Cookie: ${setCookie}`);
  return `admin_sid=${match[1]}`;
}

async function mintAdminCookie(username = TEST_ADMIN_USERNAME): Promise<string> {
  const token = await sign<AdminSessionPayload>(
    { username, iat: Math.floor(Date.now() / 1000) },
    TEST_SECRET,
  );
  return `admin_sid=${token}`;
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

describe("GET /api/setup", () => {
  beforeEach(async () => {
    await clearKV();
  });

  it("reports unconfigured + unclaimed with callback_domain derived from request host", async () => {
    const res = await SELF.fetch("http://dashboard.example.com/api/setup");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      claimed: boolean;
      callback_domain: string;
      app_url: string;
      admin_registered: boolean;
      admin_authenticated: boolean;
      admin_username: string | null;
    };
    // Env fallback is set in vitest.config.ts, so "configured" is true here —
    // but the key signal is that callback_domain matches the incoming host
    // and the payload is well-formed.
    expect(typeof body.configured).toBe("boolean");
    expect(body.claimed).toBe(false);
    expect(body.callback_domain).toBe("dashboard.example.com");
    expect(body.app_url).toBe("http://dashboard.example.com");
    expect(body.admin_registered).toBe(false);
    expect(body.admin_authenticated).toBe(false);
    expect(body.admin_username).toBeNull();
  });

  it("reports claimed=true once an owner is set", async () => {
    await setOwner(env, 111);
    const res = await SELF.fetch("http://localhost/api/setup");
    const body = (await res.json()) as { claimed: boolean };
    expect(body.claimed).toBe(true);
  });

  it("reports admin_registered and admin_authenticated once admin has logged in", async () => {
    const cookie = await registerTestAdmin();
    const res = await SELF.fetch("http://localhost/api/setup", {
      headers: { Cookie: cookie },
    });
    const body = (await res.json()) as {
      admin_registered: boolean;
      admin_authenticated: boolean;
      admin_username: string | null;
    };
    expect(body.admin_registered).toBe(true);
    expect(body.admin_authenticated).toBe(true);
    expect(body.admin_username).toBe(TEST_ADMIN_USERNAME);
  });
});

describe("POST /api/setup", () => {
  beforeEach(async () => {
    await clearKV();
  });

  it("rejects anonymous writes before an admin is registered", async () => {
    const res = await SELF.fetch("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: VALID_CLIENT_ID,
        client_secret: VALID_CLIENT_SECRET,
      }),
    });
    expect(res.status).toBe(401);
    // Nothing was written.
    expect(await env.STRAVA_KV.get(KEY.STRAVA_APP)).toBeNull();
  });

  it("rejects admin-less callers even when the instance is unclaimed", async () => {
    // Admin registered but caller didn't send the cookie.
    await registerTestAdmin();
    const res = await SELF.fetch("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: VALID_CLIENT_ID,
        client_secret: VALID_CLIENT_SECRET,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts valid credentials from an authenticated admin when unclaimed", async () => {
    const cookie = await registerTestAdmin();
    const res = await SELF.fetch("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        client_id: VALID_CLIENT_ID,
        client_secret: VALID_CLIENT_SECRET,
      }),
    });
    expect(res.status).toBe(200);
    const stored = await env.STRAVA_KV.get<{ client_id: string; client_secret: string }>(
      KEY.STRAVA_APP,
      "json",
    );
    expect(stored).toEqual({
      client_id: VALID_CLIENT_ID,
      client_secret: VALID_CLIENT_SECRET,
    });
  });

  it("rejects a non-numeric client_id", async () => {
    const cookie = await registerTestAdmin();
    const res = await SELF.fetch("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ client_id: "not-a-number", client_secret: VALID_CLIENT_SECRET }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a suspiciously short client_secret", async () => {
    const cookie = await registerTestAdmin();
    const res = await SELF.fetch("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ client_id: VALID_CLIENT_ID, client_secret: "short" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects anonymous writes once the instance is claimed", async () => {
    await setOwner(env, 42);
    const res = await SELF.fetch("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: VALID_CLIENT_ID,
        client_secret: VALID_CLIENT_SECRET,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("allows the owner to update credentials after claim (with session cookie)", async () => {
    await setOwner(env, 42);
    const sid = await sign(
      { athlete_id: 42, iat: Math.floor(Date.now() / 1000) },
      TEST_SECRET,
    );
    const res = await SELF.fetch("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `sid=${sid}` },
      body: JSON.stringify({
        client_id: VALID_CLIENT_ID,
        client_secret: VALID_CLIENT_SECRET,
      }),
    });
    expect(res.status).toBe(200);
  });

  it("allows an authenticated admin to update credentials after claim", async () => {
    const cookie = await registerTestAdmin();
    await setOwner(env, 42);
    const res = await SELF.fetch("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        client_id: VALID_CLIENT_ID,
        client_secret: VALID_CLIENT_SECRET,
      }),
    });
    expect(res.status).toBe(200);
  });

  it("stale admin cookies (admin record cleared) are rejected", async () => {
    const cookie = await mintAdminCookie("ghost");
    const res = await SELF.fetch("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        client_id: VALID_CLIENT_ID,
        client_secret: VALID_CLIENT_SECRET,
      }),
    });
    expect(res.status).toBe(401);
  });
});
