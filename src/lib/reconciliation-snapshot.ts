import { runSerializableTransaction, type TransactionRunner } from "./serializable-transaction";

/** Read every accounting projection at one database snapshot, including joins. */
export async function readReconciliationSnapshot(client: TransactionRunner) {
  return runSerializableTransaction(client, async (tx) => {
    const [journals, accounts, users, markets] = await Promise.all([
      tx.journalEntry.findMany({ include: { postings: true } }),
      tx.ledgerAccount.findMany({ include: { postings: { include: { journalEntry: { select: { status: true } } } } } }),
      tx.user.findMany({ where: { role: "USER" } }),
      tx.market.findMany({
        include: {
          collateralAccount: true,
          positions: true,
          orders: { include: { reservation: true } },
          orderFills: { select: { id: true, journalEntryId: true } },
          orderReservations: true,
        },
      }),
    ]);
    return { journals, accounts, users, markets };
  });
}
