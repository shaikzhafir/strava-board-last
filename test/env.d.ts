/// <reference types="@cloudflare/vitest-pool-workers" />

declare module "cloudflare:test" {
  // Make env typed as our Env at test time.
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface ProvidedEnv extends Env {}
}

interface Env {
  STRAVA_KV: KVNamespace;
  ASSETS: Fetcher;
  APP_URL?: string;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  STRAVA_PREFER_DEV_VARS?: string;
  SESSION_SECRET?: string;
}
