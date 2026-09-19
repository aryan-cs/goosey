/** Counts and contract metadata only. No private user fields or credentials. */
import { db, requireDatabaseStartup } from '../src/lib/db';
try {
  await requireDatabaseStartup();
  const [users, markets, migrations, worker, grants] = await Promise.all([
    db.user.groupBy({by:['role','status'],_count:true}),
    db.market.findMany({select:{id:true,slug:true,title:true,status:true,volumeMilli:true,closesAt:true,resolvesAt:true,_count:{select:{trades:true,positions:true,priceHistory:true}}},orderBy:{slug:'asc'}}),
    db.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at'),
    db.workerState.findMany(),
    db.journalEntry.count({where:{type:'WELCOME_GRANT'}}),
  ]);
  console.log(JSON.stringify({inspectionAt:new Date(),users,markets,migrations,workerCount:worker.length,welcomeGrants:grants,configuration:{appUrl:process.env.APP_URL,publicUrl:process.env.NEXT_PUBLIC_APP_URL,provider:process.env.DATABASE_PROVIDER,requireVerification:process.env.REQUIRE_EMAIL_VERIFICATION,startingFeathers:process.env.STARTING_FEATHERS,smtpConfigured:Boolean(process.env.SMTP_HOST&&process.env.SMTP_FROM)}},(_,v)=>typeof v==='bigint'?v.toString():v));
} finally {await db.$disconnect();}
