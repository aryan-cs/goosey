import { readFileSync } from "node:fs";
import { db, requireDatabaseStartup } from "../src/lib/db";
import { createAdminMarket, createMarketSchema } from "../src/lib/admin-service";
import { promoteExistingAdmin } from "./lib/promote-existing-admin";

try {
  const username = process.argv.find(arg => arg.startsWith("--username="))?.slice(11);
  if (!username) throw new Error("Supply --username=<existing-account>.");
  const catalog = JSON.parse(readFileSync(new URL("../prisma/selected-markets.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;
  if (catalog.length !== 6) throw new Error("Expected the approved six-market catalog.");
  const markets = catalog.map(({ openingProbability, pricingRationale, ...market }) => {
    void pricingRationale;
    if (openingProbability !== 0.5) throw new Error("This launcher supports only the approved neutral opening price.");
    return createMarketSchema.parse({ ...market, status: "OPEN", pricingModel: "LMSR", liquidityParameter: 40, payoutMilli: "100000", feeBps: 0 });
  });
  await requireDatabaseStartup();
  const user = await db.user.findUnique({ where: { username }, select: { id: true, username: true, role: true, status: true } });
  if (!user || user.status !== "ACTIVE" || !["USER", "ADMIN"].includes(user.role)) throw new Error("Exact active account not found; nothing changed.");
  console.log(JSON.stringify({ username: user.username, currentRole: user.role, markets: markets.map(m => m.slug) }));
  if (!process.argv.includes("--apply")) console.log("Preview only. No accounts or markets changed.");
  else {
    if (process.env.GOOSEY_CONFIRM_ADMIN_USERNAME !== username) throw new Error("Explicit username confirmation is required before promotion.");
    const actor = await promoteExistingAdmin(db, username);
    for (const market of markets) {
      const existing = await db.market.findUnique({ where: { slug: market.slug } });
      if (existing) {
        if (existing.title !== market.title || existing.closesAt.getTime() !== market.closesAt.getTime()) throw new Error(`Existing market differs: ${market.slug}; refusing to overwrite.`);
        console.log(`Already exists: ${market.slug} (${existing.status})`);
        continue;
      }
      const result = await createAdminMarket({ actorUserId: actor.id, idempotencyKey: `approved-six-v1-${market.slug}`, market });
      console.log(`Created: ${result.market.slug}`);
    }
    console.log("Approved six-market launch complete. No orders or settlements submitted.");
  }
} finally {
  await db.$disconnect();
}
