import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@goosey/postgresql-client";
import { resolveDatabaseRuntime } from "../src/lib/database-runtime";
import { verifyPostgresConnection } from "../src/lib/postgres-startup";
import { runSerializableTransaction } from "../src/lib/serializable-transaction";

const sourceUrl = process.env.POSTGRES_TEST_DATABASE_URL;
if (!sourceUrl) {
  process.stdout.write("PostgreSQL runtime smoke skipped: POSTGRES_TEST_DATABASE_URL is not set.\n");
  process.exit(0);
}

resolveDatabaseRuntime({
  DATABASE_PROVIDER: "postgresql",
  POSTGRES_DATABASE_URL: sourceUrl,
  NODE_ENV: "test",
});

const schema = `goosey_test_${randomBytes(8).toString("hex")}`;
const schemaUrl = new URL(sourceUrl);
schemaUrl.searchParams.set("schema", schema);
const isolatedUrl = schemaUrl.toString();
const admin = new PrismaClient({ datasourceUrl: sourceUrl });
const first = new PrismaClient({ datasourceUrl: isolatedUrl });
const second = new PrismaClient({ datasourceUrl: isolatedUrl });

async function migrate(): Promise<void> {
  const result = spawnSync(
    "./node_modules/.bin/prisma",
    ["migrate", "deploy", "--schema", "prisma/postgresql/schema.prisma"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        POSTGRES_DATABASE_URL: isolatedUrl,
        POSTGRES_DIRECT_DATABASE_URL: isolatedUrl,
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PostgreSQL migration rehearsal exited with status ${result.status}.`);
  const drift = spawnSync("./node_modules/.bin/prisma", [
    "migrate", "diff",
    "--from-schema-datasource", "prisma/postgresql/schema.prisma",
    "--to-schema-datamodel", "prisma/postgresql/schema.prisma",
    "--exit-code",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, POSTGRES_DATABASE_URL: isolatedUrl, POSTGRES_DIRECT_DATABASE_URL: isolatedUrl },
    stdio: "inherit",
    timeout: 60_000,
  });
  if (drift.error) throw drift.error;
  if (drift.status !== 0) throw new Error(`Applied PostgreSQL migrations differ from the current schema (status=${drift.status}).`);
}

function verifyExchange(script: string): void {
  const result = spawnSync("./node_modules/.bin/tsx", [script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_PROVIDER: "postgresql",
      DATABASE_URL: undefined,
      POSTGRES_DATABASE_URL: isolatedUrl,
      POSTGRES_DIRECT_DATABASE_URL: isolatedUrl,
      RATE_LIMIT_KEY_SECRET: randomBytes(32).toString("hex"),
    },
    stdio: "inherit",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PostgreSQL exchange verification exited with status ${result.status}.`);
}

async function main(): Promise<void> {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  try {
    await migrate();
    const startup = await verifyPostgresConnection(first);
    const userId = `runtime-${randomBytes(8).toString("hex")}`;
    await first.user.create({
      data: {
        id: userId,
        email: `${userId}@example.invalid`,
        username: userId,
        displayName: "PostgreSQL runtime smoke",
        passwordHash: "not-a-login-credential",
        emailVerifiedAt: new Date(),
        balanceMilli: 100n,
      },
    });

    let arrivals = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let retries = 0;

    async function spend(client: PrismaClient): Promise<void> {
      let attempt = 0;
      await runSerializableTransaction(
        client as never,
        async (tx) => {
          attempt += 1;
          const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
          if (user.balanceMilli < 100n) throw new Error("INSUFFICIENT_TEST_BALANCE");
          if (attempt === 1) {
            arrivals += 1;
            if (arrivals === 2) releaseBarrier?.();
            await barrier;
          }
          await tx.user.update({ where: { id: userId }, data: { balanceMilli: { decrement: 100n } } });
        },
        { provider: "postgresql", attempts: 3, jitterRatio: 0, onRetry: () => { retries += 1; } },
      );
    }

    const results = await Promise.allSettled([spend(first), spend(second)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled").length;
    const rejected = results.filter((result) => result.status === "rejected").length;
    const finalUser = await first.user.findUniqueOrThrow({ where: { id: userId } });
    if (fulfilled !== 1 || rejected !== 1 || finalUser.balanceMilli !== 0n || retries < 1) {
      throw new Error(
        `PostgreSQL concurrency contract failed (fulfilled=${fulfilled}, rejected=${rejected}, balance=${finalUser.balanceMilli}, retries=${retries}).`,
      );
    }
    process.stdout.write(
      `PostgreSQL runtime smoke passed (database=${startup.database}, serverVersionNum=${startup.serverVersionNum}, serializableRetries=${retries}).\n`,
    );
    verifyExchange("scripts/postgres-exchange-concurrency.ts");
    verifyExchange("scripts/orderbook-e2e.ts");
  } finally {
    await Promise.allSettled([first.$disconnect(), second.$disconnect()]);
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => admin.$disconnect());
