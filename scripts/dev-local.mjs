#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_VARS = resolve(ROOT, ".dev.vars");
const EXAMPLE = "local-dev.env.example";
const REQUIRED = ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET"];

function parseDotEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function die(msg) {
  process.stderr.write(`\n[dev:local] ${msg}\n\n`);
  process.exit(1);
}

if (!existsSync(DEV_VARS)) {
  die(
    `.dev.vars not found.

Create it from the template:
  cp ${EXAMPLE} .dev.vars

Then create a Strava API application at https://www.strava.com/settings/api
with Authorization Callback Domain set to "localhost", and paste the Client
ID and Client Secret into .dev.vars.`,
  );
}

const vars = parseDotEnv(readFileSync(DEV_VARS, "utf8"));
const missing = REQUIRED.filter((k) => !vars[k]);
if (missing.length) {
  die(
    `.dev.vars is missing required values: ${missing.join(", ")}

See ${EXAMPLE} for the expected format.`,
  );
}

process.stdout.write(
  `[dev:local] Strava credentials loaded from .dev.vars (client_id=${vars.STRAVA_CLIENT_ID})\n`,
);

const { createServer } = await import("vite");
const server = await createServer({
  root: ROOT,
  configFile: resolve(ROOT, "vite.config.ts"),
});
await server.listen();
server.printUrls();
