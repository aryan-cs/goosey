import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertDestination,repairSql,migration} from './repair-badge-quotes.mjs';
test('rejects a preview, wrong destination or implicit invocation',()=>{
 const e={GOOSEY_REPAIR_BADGE_QUOTES:migration,VERCEL_ENV:'production',DATABASE_PROVIDER:'postgresql',APP_URL:'https://getgoosey.vercel.app',NEON_PROJECT_ID:'round-mud-98593510'};
 assert.doesNotThrow(()=>assertDestination(e));
 for(const key of Object.keys(e))assert.throws(()=>assertDestination({...e,[key]:'wrong'}));
});
test('backup and preservation checks are inside the schema transaction',()=>{
 const sql=repairSql(readFileSync(`prisma/postgresql/migrations/${migration}/migration.sql`,'utf8'));
 assert.ok(sql.indexOf('BEGIN;')<sql.indexOf('CREATE SCHEMA'));
 assert.ok(sql.indexOf('CREATE TABLE goosey_quote_repair')<sql.indexOf('ALTER TABLE "Market"'));
 assert.ok(sql.indexOf('Market data changed')<sql.indexOf('COMMIT;'));
 assert.equal((sql.match(/COMMIT;/g)||[]).length,1);
 assert.ok(sql.includes("DEFAULT 'DATABASE'"));
 assert.throws(()=>repairSql('DROP TABLE "Market";'));
});
