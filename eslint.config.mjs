import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // Sandbox builds and local QA captures are generated artifacts, not source.
  globalIgnores([".next/**", ".next-dev/**", ".next-sandbox/**", "output/**", "node_modules/**", "coverage/**", "prisma/dev.db*", "src/generated/**"]),
]);
