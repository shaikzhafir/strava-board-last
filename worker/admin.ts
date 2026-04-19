import type { Env, AdminRecord } from "./types";
import {
  KEY,
  clearAdminLoginAttempts,
  getAdminLoginAttempts,
  incrAdminLoginAttempts,
} from "./kv";
import { getSessionSecret } from "./config";
import {
  sign,
  verify,
  adminSessionCookie,
  clearAdminSessionCookie,
  parseCookie,
  b64url,
  b64urlDecode,
  type AdminSessionPayload,
} from "./session";

/** Lightweight admin gate: salted PBKDF2-SHA256 (low iteration count). */
const PBKDF2_ITERATIONS = 10_000;
const DERIVED_KEY_BITS = 256;
const SALT_BYTES = 16;

const LOGIN_RATE_WINDOW_SECONDS = 900;
const LOGIN_RATE_MAX_ATTEMPTS = 10;

function getClientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "local";
}

/**
 * GitHub username rules (as enforced by github.com):
 *   - 1 to 39 characters
 *   - alphanumerics and single hyphens
 *   - cannot begin or end with a hyphen
 *   - cannot contain consecutive hyphens
 *
 * We store the value lowercased to match GitHub's case-insensitive semantics.
 */
const GITHUB_USERNAME_RE = /^(?=.{1,39}$)[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const MIN_PASSWORD_LENGTH = 8;

const enc = new TextEncoder();

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    DERIVED_KEY_BITS,
  );
  return b64url(new Uint8Array(bits));
}

/**
 * Constant-time string equality. `crypto.subtle.timingSafeEqual` isn't
 * available in Workers so we compare byte-by-byte after making sure both
 * sides are the same length.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function getAdmin(env: Env): Promise<AdminRecord | null> {
  return env.STRAVA_KV.get<AdminRecord>(KEY.ADMIN, "json");
}

async function putAdmin(env: Env, record: AdminRecord): Promise<void> {
  await env.STRAVA_KV.put(KEY.ADMIN, JSON.stringify(record));
}

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return GITHUB_USERNAME_RE.test(v) ? v : null;
}

export function validatePassword(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Password is required." };
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (raw.length > 1024) {
    return { ok: false, error: "Password is too long." };
  }
  return { ok: true, value: raw };
}

async function issueAdminCookie(env: Env, req: Request, username: string): Promise<string> {
  const secret = await getSessionSecret(env);
  const token = await sign<AdminSessionPayload>(
    { username, iat: Math.floor(Date.now() / 1000) },
    secret,
  );
  return adminSessionCookie(token, req);
}

/**
 * Look up the admin identity behind the incoming request, or null if the
 * request is anonymous / has an invalid cookie / doesn't match the record
 * currently in KV. This is the single chokepoint used by setup-write and
 * strava-oauth-initiate guards.
 */
export async function requireAdmin(req: Request, env: Env): Promise<AdminRecord | null> {
  const token = parseCookie(req.headers.get("Cookie"), "admin_sid");
  if (!token) return null;
  const secret = await getSessionSecret(env);
  const payload = await verify<AdminSessionPayload>(token, secret);
  if (!payload) return null;
  const admin = await getAdmin(env);
  if (!admin) return null;
  if (admin.username !== payload.username) return null;
  return admin;
}

export interface AdminStatus {
  registered: boolean;
  authenticated: boolean;
  username: string | null;
}

export async function getAdminStatus(req: Request, env: Env): Promise<AdminStatus> {
  const admin = await getAdmin(env);
  if (!admin) return { registered: false, authenticated: false, username: null };
  const authed = await requireAdmin(req, env);
  return {
    registered: true,
    authenticated: !!authed,
    username: authed ? admin.username : null,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function jsonError(message: string, status: number): Response {
  return jsonResponse({ ok: false, error: message }, { status });
}

/**
 * First-run admin registration. Succeeds only while no admin record exists
 * in KV — subsequent attempts return 409. On success the response sets an
 * `admin_sid` cookie so the operator is immediately logged in and can
 * proceed with Strava setup.
 */
export async function handleAdminRegister(req: Request, env: Env): Promise<Response> {
  const existing = await getAdmin(env);
  if (existing) {
    return jsonError(
      "Admin account is already registered. Use the login form or reset the instance to re-register.",
      409,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const b = body as { username?: unknown; password?: unknown };
  const username = normalizeUsername(b.username);
  if (!username) {
    return jsonError(
      "Enter a valid GitHub username (letters, digits, single hyphens; 1–39 chars).",
      400,
    );
  }
  const pw = validatePassword(b.password);
  if (!pw.ok) return jsonError(pw.error, 400);

  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(pw.value, saltBytes, PBKDF2_ITERATIONS);
  const record: AdminRecord = {
    username,
    salt: b64url(saltBytes),
    hash,
    iterations: PBKDF2_ITERATIONS,
    created_at: Date.now(),
  };
  await putAdmin(env, record);

  const cookie = await issueAdminCookie(env, req, username);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify({ ok: true, username }), { status: 200, headers });
}

export async function handleAdminLogin(req: Request, env: Env): Promise<Response> {
  const admin = await getAdmin(env);
  if (!admin) {
    return jsonError("No admin is registered yet — use the register form on first access.", 404);
  }

  const ip = getClientIp(req);
  const attempts = await getAdminLoginAttempts(env, ip);
  if (attempts >= LOGIN_RATE_MAX_ATTEMPTS) {
    return new Response(
      JSON.stringify({ ok: false, error: "Too many login attempts. Try again later." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(LOGIN_RATE_WINDOW_SECONDS),
        },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const b = body as { username?: unknown; password?: unknown };
  const username = normalizeUsername(b.username);
  const password = typeof b.password === "string" ? b.password : "";

  // Always run PBKDF2 even on username mismatch, so response timing doesn't
  // leak whether the username was correct.
  const salt = b64urlDecode(admin.salt);
  const candidate = await pbkdf2(password, salt, admin.iterations);
  const userOk = !!username && username === admin.username;
  const hashOk = constantTimeEqual(candidate, admin.hash);
  if (!userOk || !hashOk) {
    await incrAdminLoginAttempts(env, ip, LOGIN_RATE_WINDOW_SECONDS);
    return jsonError("Invalid username or password.", 401);
  }

  await clearAdminLoginAttempts(env, ip);
  const cookie = await issueAdminCookie(env, req, admin.username);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify({ ok: true, username: admin.username }), {
    status: 200,
    headers,
  });
}

export function handleAdminLogout(req: Request): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", clearAdminSessionCookie(req));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
