/** One-off production repair; no orders, balances or market terms are modified. */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
export const migration = '20260919233000_market_execution_backend';
export function assertDestination(e) {
  if (e.GOOSEY_REPAIR_BADGE_QUOTES !== migration || e.VERCEL_ENV !== 'production' ||
      e.DATABASE_PROVIDER !== 'postgresql' || e.APP_URL !== 'https://getgoosey.vercel.app' ||
      e.NEON_PROJECT_ID !== 'round-mud-98593510') throw new Error('Quote repair destination mismatch');
}
export function repairSql(source) {
  if (!source.startsWith('-- Apply after reviewed backup') || !source.includes('BEGIN;') || !source.trimEnd().endsWith('COMMIT;')) throw new Error('Unexpected migration structure');
  return source.replace('BEGIN;', `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE "Market" IN SHARE ROW EXCLUSIVE MODE;
CREATE SCHEMA goosey_quote_repair_20260919;
CREATE TABLE goosey_quote_repair_20260919."Market" AS TABLE public."Market";
CREATE TABLE goosey_quote_repair_20260919.migration_history AS TABLE public."_prisma_migrations";
`).replace('COMMIT;', () => `DO $$ BEGIN
IF EXISTS (SELECT to_jsonb(m) - 'executionBackend' FROM public."Market" m
           EXCEPT SELECT to_jsonb(b) FROM goosey_quote_repair_20260919."Market" b)
OR EXISTS (SELECT to_jsonb(b) FROM goosey_quote_repair_20260919."Market" b
           EXCEPT SELECT to_jsonb(m) - 'executionBackend' FROM public."Market" m)
THEN RAISE EXCEPTION 'Market data changed during schema repair'; END IF;
END $$;
COMMIT;`);
}
async function main() {
  const e={...process.env};assertDestination(e);
  e.POSTGRES_DATABASE_URL ||= e.NEON_DATABASE_URL;
  e.POSTGRES_DIRECT_DATABASE_URL ||= e.NEON_DATABASE_URL_UNPOOLED;
  const {PrismaClient}=await import('@goosey/postgresql-client');
  const p=new PrismaClient({datasources:{db:{url:e.POSTGRES_DIRECT_DATABASE_URL}},log:[]});
  function prisma(args) {
    const r=spawnSync(process.execPath,['node_modules/prisma/build/index.js',...args,'--schema','prisma/postgresql/schema.prisma'],{env:e,stdio:'inherit'});
    if(r.status!==0)throw new Error('Quote repair Prisma operation failed');
  }
  try {
    const status=await p.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name');
    if(status.some(m=>!m.finished_at&&!m.rolled_back_at))throw new Error('An unfinished database migration needs review');
    const columns=await p.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='Market' AND column_name='executionBackend'`);
    const applied=status.some(m=>m.migration_name===migration&&m.finished_at&&!m.rolled_back_at);
    console.log(JSON.stringify({project:e.NEON_PROJECT_ID,appliedMigrations:status.filter(m=>m.finished_at&&!m.rolled_back_at).map(m=>m.migration_name),executionBackendPresent:columns.length===1}));
    if(columns.length) {
      if(!applied)throw new Error('Column exists without migration record; inspect before reconciling');
      console.log('Quote schema already repaired');return;
    }
    if(applied)throw new Error('Migration record and schema disagree');
    const bad=await p.$queryRawUnsafe('SELECT id FROM "Market" WHERE "collateralAccountId" IS NULL LIMIT 1');
    if(bad.length)throw new Error('Existing database market has no collateral account');
    const sql=repairSql(readFileSync(`prisma/postgresql/migrations/${migration}/migration.sql`,'utf8'));
    const file=join(mkdtempSync(join(tmpdir(),'goosey-quote-repair-')),'repair.sql');writeFileSync(file,sql,{mode:0o600});
    prisma(['db','execute','--file',file]);
    prisma(['migrate','resolve','--applied',migration]);
    const result=await p.$queryRawUnsafe('SELECT "executionBackend",count(*)::int AS count FROM "Market" GROUP BY "executionBackend"');
    console.log(JSON.stringify({quoteSchemaRepaired:true,backup:'goosey_quote_repair_20260919',markets:result}));
  } finally {await p.$disconnect();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Quote schema repair failed; inspect migration state before retrying. Credentials suppressed.');process.exitCode=1;});
