import type { Env, StravaAppConfig, StravaTokens } from "./types";
import { getTokens, setTokens } from "./kv";
import { getStravaAppConfig } from "./config";

const TOKEN_URL = "https://www.strava.com/oauth/token";
const API_BASE = "https://www.strava.com/api/v3";

export interface OAuthTokenResponse extends StravaTokens {
  athlete?: { id: number };
}

/**
 * Single audit point for every outbound call to Strava. Emits a structured
 * JSON log line so operators can grep/aggregate call counts in Cloudflare
 * observability (e.g. filter by event=strava_api_call).
 */
function logStravaCall(payload: {
  endpoint: string;
  method: string;
  status: number;
  ms: number;
  kind: "oauth" | "api";
}) {
  console.log(JSON.stringify({ event: "strava_api_call", ...payload }));
}

async function requireAppConfig(env: Env): Promise<StravaAppConfig> {
  const cfg = await getStravaAppConfig(env);
  if (!cfg) throw new Error("Strava app is not configured — run setup first.");
  return cfg;
}

async function postToken(body: Record<string, unknown>, kind: "exchange" | "refresh"): Promise<Response> {
  const start = Date.now();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  logStravaCall({
    endpoint: `/oauth/token?grant=${kind}`,
    method: "POST",
    status: res.status,
    ms: Date.now() - start,
    kind: "oauth",
  });
  return res;
}

export async function exchangeCode(env: Env, code: string): Promise<OAuthTokenResponse> {
  const { client_id, client_secret } = await requireAppConfig(env);
  const res = await postToken(
    { client_id, client_secret, code, grant_type: "authorization_code" },
    "exchange",
  );
  if (!res.ok) throw new Error(`Strava token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshTokens(env: Env, refreshToken: string): Promise<StravaTokens> {
  const { client_id, client_secret } = await requireAppConfig(env);
  const res = await postToken(
    { client_id, client_secret, refresh_token: refreshToken, grant_type: "refresh_token" },
    "refresh",
  );
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as StravaTokens;
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at };
}

export async function getAccessToken(env: Env, athleteId: number): Promise<string> {
  const tokens = await getTokens(env, athleteId);
  if (!tokens) throw new Error("No tokens stored for athlete");
  const now = Math.floor(Date.now() / 1000);
  if (tokens.expires_at - now > 60) return tokens.access_token;
  const fresh = await refreshTokens(env, tokens.refresh_token);
  await setTokens(env, athleteId, fresh);
  return fresh.access_token;
}

export async function stravaFetch<T = unknown>(
  env: Env,
  athleteId: number,
  path: string,
): Promise<T> {
  const access = await getAccessToken(env, athleteId);
  const start = Date.now();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  logStravaCall({
    endpoint: path,
    method: "GET",
    status: res.status,
    ms: Date.now() - start,
    kind: "api",
  });
  if (!res.ok) throw new Error(`Strava API ${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
