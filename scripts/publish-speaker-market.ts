import { parseArgs } from "node:util";
import { db, requireDatabaseStartup } from "../src/lib/db";
import { createAdminMarket, createMarketSchema } from "../src/lib/admin-service";
import { LEGACY_MC_SLUG, SPEAKER_MARKET } from "../src/lib/speaker-market";
import { marketPublisher } from "./lib/market-publisher";

try {
  const {values} = parseArgs({options:{apply:{type:"boolean"}},allowPositionals:false,strict:true});
  await requireDatabaseStartup();
  const original = await db.market.findUnique({where:{slug:LEGACY_MC_SLUG},include:{_count:{select:{trades:true,positions:true,priceHistory:true,comments:true}}}});
  if (!original) throw new Error("Original MC-only contract missing; inspect before publishing.");
  const existing = await db.market.findUnique({where:{slug:SPEAKER_MARKET.slug}});
  const input = createMarketSchema.parse({...SPEAKER_MARKET,status:"OPEN",pricingModel:"LMSR",liquidityParameter:40,payoutMilli:"100000",feeBps:0});
  if (existing) {
    for (const key of ["title","shortTitle","description","rules","resolutionSource"] as const) if (existing[key] !== input[key]) throw new Error(`Existing speaker market differs at ${key}.`);
    if (existing.closesAt.getTime() !== input.closesAt.getTime() || existing.resolvesAt.getTime() !== input.resolvesAt.getTime()) throw new Error("Existing speaker market has different deadlines.");
  }
  console.log(JSON.stringify({mode:values.apply?"apply":"preview",original:{id:original.id,slug:original.slug,title:original.title,activity:original._count},separateContract:SPEAKER_MARKET,alreadyPublished:Boolean(existing),treatment:"Keep original MC-only terms, positions, comments and history unchanged."}));
  if (values.apply) {
    const actor = await marketPublisher(db);
    const market = existing ?? (await createAdminMarket({actorUserId:actor.id,idempotencyKey:"closing-speaker-separate-contract-v1",market:input})).market;
    await db.$transaction(async tx => {
      const audit = await tx.auditLog.findFirst({where:{action:"SEPARATE_SPEAKER_CONTRACT_PUBLISHED",entityId:market.id}});
      if (!audit) await tx.auditLog.create({data:{actorUserId:actor.id,action:"SEPARATE_SPEAKER_CONTRACT_PUBLISHED",entityType:"MARKET",entityId:market.id,metadata:JSON.stringify({originalMarketId:original.id,originalSlug:original.slug,treatment:"Separate broader contract; original contract scope and all accounting preserved",participantNotice:"Linked notices on both market detail pages"})}});
    });
    console.log(`Published separate contract: ${market.slug}. Original retained unchanged.`);
  }
} finally {await db.$disconnect();}
