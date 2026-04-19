import type { Env } from "./types";
import { getOwner } from "./kv";
import {
  getAppUrl,
  getCallbackDomain,
  getStravaAppConfig,
  setStravaAppConfig,
} from "./config";
import { requireOwner } from "./auth";
import { getAdmin, requireAdmin } from "./admin";

export interface SetupStatus {
  configured: boolean;
  claimed: boolean;
  app_url: string;
  callback_domain: string;
  admin_registered: boolean;
  admin_authenticated: boolean;
  admin_username: string | null;
}

export async function getSetupStatus(req: Request, env: Env): Promise<SetupStatus> {
  const [cfg, owner, admin, adminAuthed] = await Promise.all([
    getStravaAppConfig(env),
    getOwner(env),
    getAdmin(env),
    requireAdmin(req, env),
  ]);
  return {
    configured: !!cfg,
    claimed: !!owner,
    app_url: getAppUrl(env, req),
    callback_domain: getCallbackDomain(env, req),
    admin_registered: !!admin,
    admin_authenticated: !!adminAuthed,
    admin_username: adminAuthed?.username ?? null,
  };
}

function isPlausibleClientId(v: unknown): v is string {
  // Strava client IDs are short integers (5-7 digits today); accept any
  // 1-20 digit string to stay future-proof.
  return typeof v === "string" && /^\d{1,20}$/.test(v.trim());
}

function isPlausibleClientSecret(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 20 && v.trim().length <= 200;
}

/**
 * Save Strava app credentials.
 *
 * Access control (tightened to close the pre-setup claim race):
 *   - If the instance has NOT been claimed yet by a Strava athlete, an admin
 *     account MUST be registered and the caller MUST present a valid
 *     `admin_sid` cookie. First-run visitors see a register form before this
 *     endpoint is reachable.
 *   - Once an athlete has claimed the instance, the original behaviour is
 *     preserved: only the owner (valid Strava `sid` cookie) can rotate the
 *     credentials. The admin session also remains valid at that point for
 *     operational convenience.
 */
export async function handleSetupSave(req: Request, env: Env): Promise<Response> {
  const owner = await getOwner(env);

  if (owner) {
    const [ownerAuthed, adminAuthed] = await Promise.all([
      requireOwner(req, env),
      requireAdmin(req, env),
    ]);
    if (!ownerAuthed && !adminAuthed) {
      return jsonError(
        "This instance is already claimed; sign in as the owner to update credentials.",
        403,
      );
    }
  } else {
    const admin = await getAdmin(env);
    if (!admin) {
      return jsonError(
        "Register an admin account before configuring Strava credentials.",
        401,
      );
    }
    const adminAuthed = await requireAdmin(req, env);
    if (!adminAuthed) {
      return jsonError("Sign in as the admin to configure this instance.", 401);
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const b = body as { client_id?: unknown; client_secret?: unknown };
  const client_id = typeof b.client_id === "string" ? b.client_id.trim() : "";
  const client_secret = typeof b.client_secret === "string" ? b.client_secret.trim() : "";

  if (!isPlausibleClientId(client_id)) {
    return jsonError("client_id looks wrong — it should be the numeric Client ID shown on your Strava app page.", 400);
  }
  if (!isPlausibleClientSecret(client_secret)) {
    return jsonError("client_secret looks wrong — copy the full secret string from Strava (40 hex characters).", 400);
  }

  await setStravaAppConfig(env, { client_id, client_secret });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
