/** Explicit user-requested publication, with exact contract checks and no term rewrites. */
import { db, requireDatabaseStartup } from '../src/lib/db';
import { createAdminMarket, createMarketSchema, transitionAdminMarket } from '../src/lib/admin-service';
import { createAdminEvent, createEventSchema } from '../src/lib/event-service';
import { marketPublisher } from './lib/market-publisher';
import { SEPTEMBER_MARKETS, INDEPENDENT_DANCE_GROUP, INDEPENDENT_DANCE_MARKETS } from '../src/lib/september-market-additions';
import { DANCE_MARKET_OUTCOMES } from '../src/lib/dance-market';

try {
  if (process.env.GOOSEY_PUBLISH_SEPTEMBER_ADDITIONS !== '2026-09-19-approved-seven' || process.env.VERCEL_ENV !== 'production' || process.env.NEON_PROJECT_ID !== 'round-mud-98593510' || process.env.APP_URL !== 'https://getgoosey.vercel.app' || process.env.DATABASE_PROVIDER !== 'postgresql') throw Error('Publication destination or authorization mismatch');
  await requireDatabaseStartup();
  const eventInput=createEventSchema.parse(INDEPENDENT_DANCE_GROUP);
  const contracts=[...SEPTEMBER_MARKETS,...INDEPENDENT_DANCE_MARKETS.map(({label,...definition})=>{void label;return definition;})].map(definition=>createMarketSchema.parse({...definition,status:'OPEN',pricingModel:'LMSR',liquidityParameter:40,payoutMilli:'100000',feeBps:0}));
  let event=await db.marketEvent.findUnique({where:{slug:eventInput.slug}});
  if(event) for(const [field,expected] of Object.entries(eventInput)) {
    const actual=event[field as keyof typeof event];
    if(actual instanceof Date && expected instanceof Date ? actual.getTime()!==expected.getTime() : actual!==expected) throw Error('Existing independent dance event differs at '+field);
  }
  const missing=[];
  for(const contract of contracts) {
    const existing=await db.market.findUnique({where:{slug:contract.slug}});
    if(!existing){missing.push(contract);continue;}
    const dance=INDEPENDENT_DANCE_MARKETS.some(x=>x.slug===contract.slug);
    if(['title','shortTitle','description','rules','resolutionSource'].some(k=>existing[k as 'title']!==contract[k as 'title']) || existing.closesAt.getTime()!==contract.closesAt.getTime() || existing.resolvesAt.getTime()!==contract.resolvesAt.getTime() || existing.pricingModel!=='LMSR' || existing.payoutMilli!==100000n || (dance && existing.eventId!==event?.id)) throw Error('Existing contract differs; refusing overwrite: '+contract.slug);
  }
  const actor=await marketPublisher(db);
  if(!event) {const created=await createAdminEvent({actorUserId:actor.id,idempotencyKey:'independent-dances-event-v1',event:eventInput});event=await db.marketEvent.findUniqueOrThrow({where:{id:created.event.id}});}
  for(const contract of missing) {
    const dance=INDEPENDENT_DANCE_MARKETS.some(x=>x.slug===contract.slug);
    const created=await createAdminMarket({actorUserId:actor.id,idempotencyKey:'sep19-v1-'+contract.slug,market:{...contract,...(dance?{eventId:event.id}:{})}});
    console.log('Published '+created.market.slug);
  }
  // Never change a traded first-dance contract into a different bet.
  for(const option of DANCE_MARKET_OUTCOMES) {
    const old=await db.market.findUnique({where:{slug:option.slug},include:{positions:true,_count:{select:{trades:true,orders:true,orderFills:true,settlements:true,resolutionProposals:true}},settlementRun:{select:{id:true}}}});
    const untouched=old && old.volumeMilli===0n && old.traderCount===0 && !old.resolution && !old.resolvedAt && !old.settlementRun && old.positions.length===0 && Object.values(old._count).every(n=>n===0);
    if(old?.status==='OPEN' && old.pricingModel==='LMSR' && untouched) {
      try {await transitionAdminMarket({actorUserId:actor.id,marketId:old.id,action:'PAUSE',expectedVersion:old.version,reason:'Untouched first-dance contract superseded by separate independent dance options. Original terms and accounting preserved.'});console.log('Paused untouched '+old.slug);}
      catch(error) {console.log('Retained first-dance contract after concurrent change: '+old.slug);throw error;}
    } else if(old) console.log('Preserved '+old.slug+' ('+old.status+', activity='+!untouched+')');
  }
  console.log(JSON.stringify({publishedSlugs:contracts.map(x=>x.slug),independentDanceEvent:event.slug}));
} finally {await db.$disconnect();}
