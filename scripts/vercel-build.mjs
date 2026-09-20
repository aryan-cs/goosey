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

// Owner-authorized exact-market settlement; absent on ordinary builds.
if (env.GOOSEY_CITADEL_SETTLEMENT) {
  run("db:generate");
  const result = spawnSync("node", ["--import", "tsx", "scripts/settle-citadel.ts"], { env, stdio: "inherit" });
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

// Separate one-time September bot-incident cleanup. Preview is read-only; apply
// requires the reviewed snapshot digest and exact confirmation inside the script.
if (env.GOOSEY_BOT_CLEANUP_MODE) {
  if (!["preview", "apply"].includes(env.GOOSEY_BOT_CLEANUP_MODE)) throw new Error("Invalid bot cleanup mode");
  run("db:generate");
  const result = spawnSync("node", ["--import", "tsx", "scripts/remove-production-bot-accounts.ts", ...(env.GOOSEY_BOT_CLEANUP_MODE === "apply" ? ["--apply"] : [])], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (env.GOOSEY_BOT_CLEANUP_MODE === "apply") run("reconcile");
}

// Exact post-incident verification. Apply only purges quotes invalidated by the
// market replay, then runs the same comprehensive assertions as preview.
if (env.GOOSEY_BOT_POSTCHECK_MODE) {
  if (!["preview", "apply"].includes(env.GOOSEY_BOT_POSTCHECK_MODE)) throw new Error("Invalid bot postcheck mode");
  run("db:generate");
  const result = spawnSync("node", ["--import", "tsx", "scripts/verify-production-bot-cleanup.ts", ...(env.GOOSEY_BOT_POSTCHECK_MODE === "apply" ? ["--apply"] : [])], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (env.GOOSEY_BOT_POSTCHECK_MODE === "apply") run("reconcile");
}

// One-time, exact correction authorized by the owner while the market is live.
if (env.GOOSEY_CORRECT_CITADEL_DEADLINE) {
  run("db:generate");
  const result = spawnSync("node", ["--import", "tsx", "scripts/correct-citadel-deadline.ts"], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (env.GOOSEY_VERIFY_LEADERBOARD === "1") {
  run("db:generate");
  const result = spawnSync("node", ["--import", "tsx", "scripts/verify-production-leaderboard.ts"], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (env.GOOSEY_PUBLISH_SEPTEMBER_ADDITIONS) {
  run("db:generate");
  const result = spawnSync("node", ["--import", "tsx", "scripts/publish-september-additions.ts"], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (env.GOOSEY_UNPUBLISH_SPEAKER) {
  run("db:generate");
  const result = spawnSync("node", ["--import", "tsx", "scripts/unpublish-duplicate-speaker-market.ts"], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Explicit one-off repair for the deployed badge quote/schema mismatch.
if (env.GOOSEY_REPAIR_BADGE_QUOTES) {
  run("db:generate:postgres");
  const result = spawnSync("node", ["scripts/repair-badge-quotes.mjs"], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Explicit opt-in: preview builds must not silently mutate shared databases.
if (env.GOOSEY_DEPLOY_MIGRATIONS === "1") run("db:migrate:deploy:postgres");
run("build");
