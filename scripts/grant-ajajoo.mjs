// Explicit operator-requested additional grant. Never runs on ordinary builds.
import assert from 'node:assert/strict';
const key='arsonistduck-set-13-20260919-01';
assert.equal(process.env.GOOSEY_ACCOUNT_GRANT,key);
assert.equal(process.env.VERCEL_ENV,'production');
assert.equal(process.env.APP_URL,'https://getgoosey.vercel.app');
assert.equal(process.env.DATABASE_PROVIDER,'postgresql');
assert.equal(process.env.NEON_PROJECT_ID,'round-mud-98593510');
const {PrismaClient}=await import('@goosey/postgresql-client');
const db=new PrismaClient({datasources:{db:{url:process.env.POSTGRES_DIRECT_DATABASE_URL||process.env.NEON_DATABASE_URL_UNPOOLED}},log:[]});
const target=13000n;
try {
 const result=await db.$transaction(async tx=>{
  const user=await tx.user.findUnique({where:{username:'arsonistduck'},select:{id:true,username:true,status:true,role:true,balanceMilli:true}});
  assert(user,'Exact username not found');assert.equal(user.status,'ACTIVE');assert.equal(user.role,'USER');
  const prior=await tx.journalEntry.findUnique({where:{idempotencyScope_idempotencyKey:{idempotencyScope:'OPERATOR_GRANT',idempotencyKey:key}},include:{postings:true}});
  if(prior){assert.equal(prior.referenceId,user.id);assert.equal(JSON.parse(prior.metadata).targetMilli,target.toString());return {alreadyApplied:true,username:user.username,balanceMilli:user.balanceMilli.toString(),journalId:prior.id};}
  const wallet=await tx.ledgerAccount.findUnique({where:{ownerType_ownerId_purpose:{ownerType:'USER',ownerId:user.id,purpose:'USER_FEATHERS'}}});
  const issuance=await tx.ledgerAccount.findUnique({where:{ownerType_ownerId_purpose:{ownerType:'SYSTEM',ownerId:'issuance',purpose:'ISSUANCE'}}});
  assert(wallet&&issuance,'Existing ledger accounts required');assert.equal(wallet.status,'ACTIVE');assert.equal(issuance.status,'ACTIVE');assert(issuance.allowsNegative);assert.equal(wallet.balanceMilli,user.balanceMilli);
  const sum=await tx.ledgerPosting.aggregate({where:{ledgerAccountId:wallet.id,journalEntry:{status:'POSTED'}},_sum:{amountMilli:true}});
  assert.equal(sum._sum.amountMilli??0n,wallet.balanceMilli,'Wallet must reconcile before grant');
  const before=user.balanceMilli;
  const amount=target-before;
  const journal=await tx.journalEntry.create({data:{type:'OPERATOR_ADJUSTMENT',status:'POSTED',referenceType:'USER',referenceId:user.id,idempotencyScope:'OPERATOR_GRANT',idempotencyKey:key,metadata:JSON.stringify({username:user.username,targetMilli:target.toString(),amountMilli:amount.toString(),beforeMilli:before.toString(),afterMilli:(before+amount).toString(),issuanceBeforeMilli:issuance.balanceMilli.toString(),reason:'User explicitly requested setting arsonistduck feather balance to 13 via Codex',operator:'Codex operator session',operationId:key}),postings:{create:[{ledgerAccountId:issuance.id,amountMilli:-amount},{ledgerAccountId:wallet.id,amountMilli:amount}]}}});
  await tx.ledgerAccount.update({where:{id:issuance.id},data:{balanceMilli:{decrement:amount}}});
  const updatedWallet=await tx.ledgerAccount.update({where:{id:wallet.id},data:{balanceMilli:{increment:amount}}});
  const updatedUser=await tx.user.update({where:{id:user.id},data:{balanceMilli:{increment:amount}}});
  assert.equal(updatedWallet.balanceMilli,before+amount);assert.equal(updatedUser.balanceMilli,updatedWallet.balanceMilli);
  const check=await tx.ledgerPosting.aggregate({where:{ledgerAccountId:wallet.id,journalEntry:{status:'POSTED'}},_sum:{amountMilli:true}});assert.equal(check._sum.amountMilli,updatedWallet.balanceMilli);
  return {applied:true,username:user.username,targetFeathers:13,beforeMilli:before.toString(),afterMilli:updatedWallet.balanceMilli.toString(),journalId:journal.id};
 },{isolationLevel:'Serializable',timeout:20000});
 console.log('ACCOUNT_GRANT_RESULT',JSON.stringify(result));
} finally {await db.$disconnect();}
