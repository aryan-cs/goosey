/** Owner-authorized YES settlement. Inspect is read-only; apply uses audited services. */
import { db } from '../src/lib/db';
import { createResolutionProposal, approveResolutionProposal } from '../src/lib/admin-service';
import { processSettlementRun } from '../src/lib/settlement-service';
import { requireDatabaseFinancialMarket } from '../src/lib/market-backend';
const slug = 'htn-2026-chinese-citadel-poker-winner';
const mode = process.env.GOOSEY_CITADEL_SETTLEMENT;
if (!['inspect', 'apply'].includes(mode ?? '')) throw new Error('Explicit mode required');
if (process.env.VERCEL_ENV !== 'production' || process.env.APP_URL !== 'https://getgoosey.vercel.app' || process.env.DATABASE_PROVIDER !== 'postgresql' || process.env.NEON_PROJECT_ID !== 'round-mud-98593510') throw new Error('Wrong destination');
const print = (v: unknown) => console.log('CITADEL_SETTLEMENT ' + JSON.stringify(v, (_, v) => typeof v === 'bigint' ? v.toString() : v));
try {
 const market = await db.market.findUniqueOrThrow({where:{slug},include:{collateralAccount:true,positions:{include:{user:{select:{id:true,username:true,balanceMilli:true}}}},resolutionProposals:true,settlementRun:true}});
 requireDatabaseFinancialMarket(market);
 if (market.id !== "cmu8ulw23000kgm54pwyooyfw") throw new Error("Unexpected market identity");
 const admins = await db.user.findMany({where:{role:'ADMIN',status:'ACTIVE'},select:{id:true,username:true},orderBy:{createdAt:'asc'}});
 print({mode,market:{id:market.id,title:market.title,rules:market.rules,status:market.status,resolution:market.resolution,closesAt:market.closesAt,resolvesAt:market.resolvesAt,pricingModel:market.pricingModel,collateral:market.collateralAccount?.balanceMilli,positions:market.positions.map(p=>({userId:p.userId,username:p.user.username,yes:p.yesShares,no:p.noShares,balance:p.user.balanceMilli,expectedPayout:BigInt(p.yesShares)*market.payoutMilli})),proposals:market.resolutionProposals,run:market.settlementRun},admins});
 if (mode === 'apply') {
  const actor = admins.find(a => a.id === market.createdById) ?? admins[0];
  if (!actor) throw new Error('No active administrator');
  if (market.resolution && market.resolution !== 'YES') throw new Error('Conflicting outcome');
  let run = market.settlementRun;
  if (!run) {
   if (market.resolutionProposals.some(p=>p.status==='PENDING')) throw new Error('Existing proposal requires review');
   const proposal = await createResolutionProposal({actorUserId:actor.id,marketId:market.id,idempotencyKey:'citadel-owner-yes-20260919-proposal',resolution:{outcome:'YES',reason:'Market owner confirmed that the Citadel Poker YES condition was satisfied and explicitly requested settlement.',evidence:'Owner instruction on September 19, 2026: the Citadel kid poker tournament market resolved to yes. This records the owner confirmation; no ethnicity inference was made.'}});
   const approved = await approveResolutionProposal({actorUserId:actor.id,proposalId:proposal.proposal.id,idempotencyKey:'citadel-owner-yes-20260919-approval'});
   run = approved.run;
  }
  if (run.outcome !== 'YES') throw new Error('Unexpected settlement outcome');
  for(let i=0;i<100;i++) {
   const result = await processSettlementRun({actorUserId:actor.id,runId:run.id,batchSize:100});
   if(result.run.status==='COMPLETED') break;
   if(i===99) throw new Error('Settlement remains incomplete');
  }
  const [final,settlements,positions,snapshot] = await Promise.all([
   db.market.findUniqueOrThrow({where:{id:market.id},include:{settlementRun:true}}),
   db.positionSettlement.findMany({where:{marketId:market.id}}),
   db.position.count({where:{marketId:market.id,OR:[{yesShares:{gt:0}},{noShares:{gt:0}},{reservedYesShares:{gt:0}},{reservedNoShares:{gt:0}}]}}),
   db.marketPriceSnapshot.findFirst({where:{marketId:market.id},orderBy:{createdAt:'desc'}})
  ]);
  if(final.status!=='RESOLVED'||final.resolution!=='YES'||final.settlementRun?.status!=='COMPLETED'||positions!==0||snapshot?.yesProbabilityBps!==10000) throw new Error('Final state verification failed');
  for (const settlement of settlements) {
   const original = market.positions.find(p => p.userId === settlement.userId);
   if (!market.settlementRun && (!original || settlement.payoutMilli !== BigInt(original.yesShares) * market.payoutMilli)) throw new Error('Position payout mismatch');
   if (settlement.payoutMilli > 0n) {
    if (!settlement.journalEntryId) throw new Error('Missing payout journal');
    const journal = await db.journalEntry.findUniqueOrThrow({where:{id:settlement.journalEntryId},include:{postings:{include:{ledgerAccount:true}}}});
    if (journal.postings.reduce((sum,p)=>sum+p.amountMilli,0n)!==0n || !journal.postings.some(p=>p.ledgerAccount.ownerId===settlement.userId && p.amountMilli===settlement.payoutMilli)) throw new Error('Payout ledger mismatch');
   }
  }
  print({verified:true,run:final.settlementRun,snapshot,settlements:settlements.map(s=>({userId:s.userId,username:market.positions.find(p=>p.userId===s.userId)?.user.username,payout:s.payoutMilli,journalEntryId:s.journalEntryId}))});
 }
} finally { await db.$disconnect(); }
