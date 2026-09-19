/** Explicit account removal, preserving immutable ledger history. Never a normal build step. */
import { db, requireDatabaseStartup } from '../src/lib/db';
import { marketPublisher } from './lib/market-publisher';
const targets = [
  ['cmu8qeknn0000jq04c211pfdh','qa_mu8qej35'],
  ['cmu8r2cp90000l304n3wiglzx','qa_mu8r2c0g'],
  ['cmu8raeqz000hl204sc9fsz3m','qa_mu8radws'],
  ['cmu8s9lf10000k104dcjmugia','testuser'],
] as const;
try {
  if (process.env.GOOSEY_REMOVE_TEST_ACCOUNTS !== '2026-09-19-four-reviewed-accounts' || process.env.VERCEL_ENV !== 'production' || process.env.NEON_PROJECT_ID !== 'round-mud-98593510' || process.env.APP_URL !== 'https://getgoosey.vercel.app' || process.env.DATABASE_PROVIDER !== 'postgresql') throw Error('Account removal destination or authorization mismatch');
  await requireDatabaseStartup();
  const actor = await marketPublisher(db);
  const result = await db.$transaction(async tx => {
    const removed:string[]=[];
    for(const [id,username] of targets) {
      const user=await tx.user.findUnique({where:{id},include:{_count:{select:{trades:true,positions:true,comments:true,marketOrders:true,solanaWalletLinks:true,createdMarkets:true,createdEvents:true}}}});
      if(!user) throw Error('Reviewed account missing: '+username);
      if(user.status==='DELETED' && user.username==='deleted_'+id) continue;
      if(user.username!==username || user.role!=='USER' || user.status!=='ACTIVE' || Object.values(user._count).some(n=>n!==0)) throw Error('Reviewed test account changed or has activity; refusing removal: '+username);
      const now=new Date();
      await tx.session.deleteMany({where:{userId:id}});
      await tx.accountToken.updateMany({where:{userId:id,consumedAt:null},data:{consumedAt:now}});
      await tx.solanaWalletLinkChallenge.updateMany({where:{userId:id,consumedAt:null},data:{consumedAt:now}});
      await tx.user.update({where:{id},data:{status:'DELETED',username:'deleted_'+id,email:'deleted-'+id+'@invalid.example',displayName:'Deleted test account',bio:'',profilePublic:false,leaderboardVisible:false,passwordHash:'ACCOUNT_REMOVED'}});
      await tx.auditLog.create({data:{actorUserId:actor.id,action:'TEST_ACCOUNT_REMOVED',entityType:'USER',entityId:id,metadata:JSON.stringify({formerUsername:username,reason:'User requested removal of all test/QA accounts',treatment:'Account anonymized, sessions revoked, ledger balances and welcome-grant journals preserved'})}});
      removed.push(username);
    }
    return {removed,remainingActivePlayers:await tx.user.count({where:{role:'USER',status:'ACTIVE'}})};
  },{isolationLevel:'Serializable',timeout:30000});
  console.log(JSON.stringify({testAccountRemoval:result}));
} finally {await db.$disconnect();}
