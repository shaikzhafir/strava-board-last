const enc = new TextEncoder();
const dec = new TextDecoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface SessionPayload {
  athlete_id: number;
  iat: number;
}

export interface AdminSessionPayload {
  username: string;
  iat: number;
}

export async function sign<T extends object = SessionPayload>(
  payload: T,
  secret: string,
): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verify<T = SessionPayload>(
  token: string,
  secret: string,
): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), enc.encode(body));
  if (!ok) return null;
  try {
    return JSON.parse(dec.decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

export { b64url, b64urlDecode };

/**
 * Drop the `Secure` flag when the worker is being accessed over plain HTTP
 * (local dev on http://localhost, http://127.0.0.1, or a bare IP). Browsers
 * refuse to store a Secure cookie set over an insecure origin, which would
 * silently break the admin / OAuth flows during `npm run dev`. In production
 * the request is always https and the flag stays on.
 */
function isSecureOrigin(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}

function cookieAttrs(req: Request, maxAgeSeconds: number): string {
  const base = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  return isSecureOrigin(req) ? `${base}; Secure` : base;
}

export function sessionCookie(
  token: string,
  req: Request,
  maxAgeSeconds = 60 * 60 * 24 * 30,
): string {
  return `sid=${token}; ${cookieAttrs(req, maxAgeSeconds)}`;
}

export function clearSessionCookie(req: Request): string {
  return `sid=; ${cookieAttrs(req, 0)}`;
}

export function adminSessionCookie(
  token: string,
  req: Request,
  maxAgeSeconds = 60 * 60 * 24 * 30,
): string {
  return `admin_sid=${token}; ${cookieAttrs(req, maxAgeSeconds)}`;
}

export function clearAdminSessionCookie(req: Request): string {
  return `admin_sid=; ${cookieAttrs(req, 0)}`;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}
