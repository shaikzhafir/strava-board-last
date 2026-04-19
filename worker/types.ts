export interface Env {
  STRAVA_KV: KVNamespace;
  ASSETS: Fetcher;
  // All of the following are optional. They exist only as a fallback for local
  // development via `.dev.vars` or for operators who prefer setting them as
  // wrangler secrets. In production, the recommended flow is to leave these
  // unset and configure Strava credentials via the in-app setup wizard, which
  // stores them in KV. See worker/config.ts.
  APP_URL?: string;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  /** Local dev only: when `"true"` or `"1"`, use STRAVA_* from env before KV so `.dev.vars` edits apply after restart. */
  STRAVA_PREFER_DEV_VARS?: string;
  SESSION_SECRET?: string;
}

export interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface StravaAppConfig {
  client_id: string;
  client_secret: string;
}

/**
 * Admin credential record stored in KV. The operator's password is never
 * stored in plaintext — only the PBKDF2-SHA256 derived key (base64url) and
 * its salt (base64url). `iterations` is persisted so we can safely bump the
 * cost parameter in the future without invalidating older records.
 */
export interface AdminRecord {
  username: string;
  salt: string;
  hash: string;
  iterations: number;
  created_at: number;
}

export interface StravaAthlete {
  id: number;
  username: string | null;
  firstname: string;
  lastname: string;
  profile: string;
  profile_medium: string;
  city: string | null;
  country: string | null;
  sex: string | null;
}

export interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  average_speed: number;
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  map: { summary_polyline: string | null };
}

export interface DailyActivity {
  count: number;
  distance_m: number;
}

export interface DailyActivityMap {
  byDate: Record<string, DailyActivity>;
  years: number[];
  syncedAt: string;
}

export interface StravaStats {
  recent_run_totals: Totals;
  recent_ride_totals: Totals;
  recent_swim_totals: Totals;
  ytd_run_totals: Totals;
  ytd_ride_totals: Totals;
  all_run_totals: Totals;
  all_ride_totals: Totals;
}

interface Totals {
  count: number;
  distance: number;
  moving_time: number;
  elevation_gain: number;
}
