import type { Env } from "./types";
import { reconcileDevStravaAppSwitch } from "./dev-strava-reset";
import { loginRedirect, handleCallback, handleLogout, requireOwner } from "./auth";
import {
  getCachedAthlete,
  getCachedStats,
  getCachedDaily,
  getLastSyncedAt,
} from "./kv";
import { runSync } from "./sync";
import { getSetupStatus, handleSetupSave } from "./setup";
import {
  handleAdminLogin,
  handleAdminLogout,
  handleAdminRegister,
} from "./admin";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await reconcileDevStravaAppSwitch(env);
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    // --- Setup (first-run onboarding) ---
    if (pathname === "/api/setup" && method === "GET") {
      return json(await getSetupStatus(req, env));
    }
    if (pathname === "/api/setup" && method === "POST") {
      return handleSetupSave(req, env);
    }

    // --- Admin auth (gates the setup wizard during pre-claim) ---
    if (pathname === "/api/admin/register" && method === "POST") {
      return handleAdminRegister(req, env);
    }
    if (pathname === "/api/admin/login" && method === "POST") {
      return handleAdminLogin(req, env);
    }
    if (pathname === "/api/admin/logout" && method === "POST") {
      return handleAdminLogout(req);
    }

    // --- Auth routes ---
    if (pathname === "/auth/strava/login" && method === "GET") {
      return loginRedirect(req, env);
    }
    if (pathname === "/auth/strava/callback" && method === "GET") {
      return handleCallback(req, env, ctx);
    }
    if (pathname === "/auth/logout" && method === "POST") {
      return handleLogout(req);
    }

    // --- API routes (publicly readable, single-user model) ---
    if (pathname === "/api/me" && method === "GET") {
      const [athlete, lastSyncedAt] = await Promise.all([
        getCachedAthlete(env),
        getLastSyncedAt(env),
      ]);
      return json({ athlete, lastSyncedAt });
    }

    if (pathname === "/api/stats" && method === "GET") {
      return json((await getCachedStats(env)) ?? null);
    }

    if (pathname === "/api/daily-activity" && method === "GET") {
      return json((await getCachedDaily(env)) ?? null);
    }

    if (pathname === "/api/sync" && method === "POST") {
      const owner = await requireOwner(req, env);
      if (!owner) return json({ error: "unauthorized" }, { status: 401 });
      ctx.waitUntil(runSync(env).catch(() => {}));
      return json({ ok: true, queued: true }, { status: 202 });
    }

    // --- Static assets (SPA) ---
    return env.ASSETS.fetch(req);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await reconcileDevStravaAppSwitch(env);
        await runSync(env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
