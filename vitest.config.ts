import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        main: "./worker/index.ts",
        miniflare: {
          compatibilityDate: "2024-11-06",
          compatibilityFlags: ["nodejs_compat"],
          kvNamespaces: ["STRAVA_KV"],
          bindings: {
            // APP_URL intentionally omitted — the worker derives its public
            // origin from the incoming request so tests exercise the same path
            // as production.
            STRAVA_CLIENT_ID: "test-client-id",
            STRAVA_CLIENT_SECRET: "test-client-secret",
            SESSION_SECRET: "test-session-secret-please-change",
          },
        },
      },
    },
  },
});
