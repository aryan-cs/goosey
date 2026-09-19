/** Explicit one-off release runner. Normal vercel builds never invoke this. */
import { spawnSync } from 'node:child_process';
const apply = process.argv.includes('--apply');
const env = {...process.env, POSTGRES_DATABASE_URL:process.env.POSTGRES_DATABASE_URL || process.env.NEON_DATABASE_URL, POSTGRES_DIRECT_DATABASE_URL:process.env.POSTGRES_DIRECT_DATABASE_URL || process.env.NEON_DATABASE_URL_UNPOOLED, GOOSEY_DEPLOY_MIGRATIONS:'0'};
if (env.VERCEL_ENV !== 'production' || env.DATABASE_PROVIDER !== 'postgresql' || env.APP_URL !== 'https://getgoosey.vercel.app' || env.NEON_PROJECT_ID !== 'round-mud-98593510') throw new Error('Release destination does not match reviewed Goosey production.');
if (apply && env.GOOSEY_RELEASE_BACKUP !== 'br-curly-dew-avzfuhg3') throw new Error('Explicit reviewed recovery branch required.');
function run(command,args,extra={}) {const r=spawnSync(command,args,{env:{...env,...extra},stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
run('npm',['run','db:generate']);
run('node',['--import','tsx','scripts/production-inspection.ts']);
run('node',['--import','tsx','scripts/publish-dance-markets.ts','--system-operator',...(apply?['--apply']:[])]);
run('node',['--import','tsx','scripts/launch-selected-markets.ts','--system-operator','--slug=htn-2026-all-toronto-team-wins',...(apply?['--apply']:[])],{GOOSEY_CONFIRM_MARKET_LAUNCH:'htn-2026-all-toronto-team-wins'});
run('node',['--import','tsx','scripts/publish-speaker-market.ts',...(apply?['--apply']:[])]);
run('node',['--import','tsx','scripts/production-inspection.ts']);
