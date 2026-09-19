import { validatePostgresDeploymentEnvironment } from "../src/lib/postgres-deployment-env";

try {
  validatePostgresDeploymentEnvironment(process.env);
  process.stdout.write("PostgreSQL deployment environment passed preflight.\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
