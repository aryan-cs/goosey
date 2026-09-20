import { db, requireDatabaseStartup } from "../src/lib/db";
import { backfillSettlementAttestations } from "../src/lib/solana/settlement-attestation-backfill";

async function main() {
  await requireDatabaseStartup();
  const actor = await db.user.findFirst({
    where: { role: "SYSTEM", status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!actor) throw new Error("An active SYSTEM principal is required for settlement attestation backfill");
  let totals = { examined: 0, created: 0 };
  for (;;) {
    const batch = await backfillSettlementAttestations({ actorUserId: actor.id, limit: 100 });
    totals = { examined: totals.examined + batch.examined, created: totals.created + batch.created };
    if (!batch.hasMore || batch.created === 0) break;
  }
  console.log(JSON.stringify({ event: "settlement_attestation_backfill_complete", ...totals }));
}

void main()
  .catch(error => {
    console.error(JSON.stringify({
      event: "settlement_attestation_backfill_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
    }));
    process.exitCode = 1;
  })
  .finally(async () => db.$disconnect());
