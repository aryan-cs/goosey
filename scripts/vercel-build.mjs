import { spawnSync } from "node:child_process";

// Keep integration credentials server-side. Never put them in next.config.env.
const env = { ...process.env };
env.POSTGRES_DATABASE_URL ??= env.NEON_DATABASE_URL;
env.POSTGRES_DIRECT_DATABASE_URL ??= env.NEON_DATABASE_URL_UNPOOLED;

function run(script) {
  const result = spawnSync("npm", ["run", script], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// One-off, explicitly requested publication, guarded by destination and backup.
// This is build-only configuration; ordinary deploys do not publish records.
if (env.GOOSEY_CEREMONY_RELEASE_MODE) {
  if (!["preview", "apply"].includes(env.GOOSEY_CEREMONY_RELEASE_MODE)) throw new Error("Invalid release mode");
  const result = spawnSync("node", ["scripts/production-release.mjs", ...(env.GOOSEY_CEREMONY_RELEASE_MODE === "apply" ? ["--apply"] : [])], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (env.GOOSEY_PREPARE_DEV_BRANCH) {
  run("db:generate");
  const result = spawnSync("node", ["--import", "tsx", "scripts/prepare-neon-development.ts"], {env, stdio:"inherit"});
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Explicit one-time account removal; guarded by exact reviewed identities and activity checks.
if (env.GOOSEY_REMOVE_TEST_ACCOUNTS) {
  run("db:generate");
  const result = spawnSync("node", ["--import", "tsx", "scripts/remove-test-accounts.ts"], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Explicit opt-in: preview builds must not silently mutate shared databases.
if (env.GOOSEY_DEPLOY_MIGRATIONS === "1") run("db:migrate:deploy:postgres");
run("build");
