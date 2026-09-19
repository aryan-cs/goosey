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

// Explicit opt-in: preview builds must not silently mutate shared databases.
if (env.GOOSEY_DEPLOY_MIGRATIONS === "1") run("db:migrate:deploy:postgres");
run("build");
