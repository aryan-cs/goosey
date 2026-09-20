import { address, type Address } from "@solana/kit";

import { readGooseyEscrow } from "@/lib/solana/escrow-read";
import { orderCashDeficit } from "@/lib/solana/order-reserve";
import type { SolanaRuntime } from "@/lib/solana/runtime";

type EscrowSnapshot = Awaited<ReturnType<typeof readGooseyEscrow>>;

export type ManagedMarketReadinessPlan =
  | Readonly<{ status: "register-seat"; observedSlot: bigint }>
  | Readonly<{ status: "deposit"; amount: bigint; requiredCash: bigint; availableCash: bigint;
      walletTokenAmount: bigint; expectedNonce: bigint; observedSlot: bigint }>
  | Readonly<{ status: "ready"; requiredCash: bigint; availableCash: bigint;
      expectedNonce: bigint; observedSlot: bigint }>;

type Dependencies = Readonly<{
  read?: (runtime: SolanaRuntime, input: Readonly<{ marketId: bigint; wallet: Address }>, options: Readonly<{
    signal?: AbortSignal; includeResolution: true;
  }>) => Promise<EscrowSnapshot>;
}>;

/**
 * Produces the next deterministic readiness step from one finalized market
 * snapshot. It never signs, sends, deposits, or treats reserved cash as free.
 */
export async function planManagedMarketReadiness(input: Readonly<{
  runtime: SolanaRuntime;
  walletAddress: string;
  marketId: bigint;
  action: "BUY" | "SELL";
  limitPriceMilli: bigint;
  quantity: bigint;
  signal?: AbortSignal;
}>, dependencies: Dependencies = {}): Promise<ManagedMarketReadinessPlan> {
  const wallet = address(input.walletAddress);
  const read = dependencies.read ?? readGooseyEscrow;
  const snapshot = await read(input.runtime, { marketId: input.marketId, wallet }, {
    signal: input.signal,
    includeResolution: true,
  });
  if (snapshot.wallet !== wallet || typeof snapshot.finalizedSlot !== "bigint" || snapshot.finalizedSlot < 0n
    || !snapshot.orderBook?.reservesReconciled) {
    throw new Error("Managed market readiness snapshot is incomplete or mismatched");
  }
  if (!snapshot.registered || !snapshot.seat) {
    if (snapshot.registered !== false || snapshot.seat !== null) {
      throw new Error("Managed market seat state is inconsistent");
    }
    return Object.freeze({ status: "register-seat", observedSlot: snapshot.finalizedSlot });
  }
  const requiredCash = input.action === "BUY"
    ? orderCashDeficit({ action: "BUY", limitPriceMilli: input.limitPriceMilli, quantity: input.quantity,
      feeBps: snapshot.marketState.feeBps, availableCash: 0n })
    : 0n;
  const availableCash = snapshot.seat.availableCash;
  const amount = requiredCash > availableCash ? requiredCash - availableCash : 0n;
  if (amount === 0n) {
    return Object.freeze({ status: "ready", requiredCash, availableCash,
      expectedNonce: snapshot.seat.nextNonce, observedSlot: snapshot.finalizedSlot });
  }
  if (snapshot.walletTokenAmount === null || snapshot.walletTokenAmount < amount) {
    throw new Error("Insufficient free feathers for this order");
  }
  return Object.freeze({ status: "deposit", amount, requiredCash, availableCash,
    walletTokenAmount: snapshot.walletTokenAmount, expectedNonce: snapshot.seat.nextNonce,
    observedSlot: snapshot.finalizedSlot });
}

