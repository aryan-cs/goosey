/** User-requested removal of the unused duplicate; retain its audit/history record. */
import { db, requireDatabaseStartup } from '../src/lib/db';
import { marketPublisher } from './lib/market-publisher';
try {
 if(process.env.GOOSEY_UNPUBLISH_SPEAKER!=='2026-09-19-duplicate' || process.env.VERCEL_ENV!=='production' || process.env.APP_URL!=='https://getgoosey.vercel.app' || process.env.NEON_PROJECT_ID!=='round-mud-98593510') throw Error('Unpublish destination/authorization mismatch');
 await requireDatabaseStartup();const actor=await marketPublisher(db);
 await db.$transaction(async tx=>{
  const market=await tx.market.findUniqueOrThrow({where:{slug:'htn-2026-closing-speaker-does-67'},include:{_count:{select:{trades:true,positions:true,orders:true,comments:true}}}});
  if(await tx.auditLog.findFirst({where:{action:'DUPLICATE_SPEAKER_UNPUBLISHED',entityId:market.id}}))return;
  if(market.id!=='cmu8tqg770002gm761d707mb1' || market.status!=='OPEN' || market.yesShares!==0 || market.noShares!==0 || market.volumeMilli!==0n || Object.values(market._count).some(n=>n>0)) throw Error('Duplicate now has activity or changed state; preserve it and inspect instead');
  const updated=await tx.market.updateMany({where:{id:market.id,version:market.version,status:'OPEN'},data:{status:'DRAFT',featured:false,acceptingOrders:false,version:{increment:1}}});
  if(updated.count!==1)throw Error('Concurrent market change');
  await tx.auditLog.create({data:{actorUserId:actor.id,action:'DUPLICATE_SPEAKER_UNPUBLISHED',entityType:'MARKET',entityId:market.id,metadata:JSON.stringify({reason:'User requested removal of duplicate closing-speaker 67 market',retainedMarketSlug:'htn-2026-mc-does-67',treatment:'Untouched duplicate hidden as DRAFT; all history and financial records retained'})}});
 });
 console.log('Duplicate closing-speaker market unpublished; original MC contract retained.');
}finally{await db.$disconnect();}
