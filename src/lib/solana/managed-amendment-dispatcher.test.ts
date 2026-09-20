import { createNoopSigner, type Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import type { StoredChainCommand } from "./chain-command-store";
import { dispatchManagedAmendmentCommand, verifyFinalizedManagedAmendment } from "./managed-amendment-dispatcher";

const PROGRAM = "Vote111111111111111111111111111111111111111", GENESIS = "Stake11111111111111111111111111111111111111";
const SPONSOR = "11111111111111111111111111111111" as Address;
const PARTICIPANT = "SysvarRent111111111111111111111111111111111" as Address;
const env = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: GENESIS };
const requestJson = JSON.stringify({ operation: "REPLACE_ORDER", request: { cancelOnPause: true,
  chainMarketId: "7", clientOrderId: "replacement-123", expectedVersion: 9, limitPriceMilli: "450",
  marketId: "market_1", marketSlug: "market-one", orderId: "42", postOnly: false, quantity: 3,
  selfTradePrevention: "CANCEL_AGGRESSOR" }, version: 1 });
const now = new Date("2026-09-20T00:00:01Z");

function command(status: StoredChainCommand["state"]["status"], revision: number, epoch = 0,
  leased = epoch > 0): StoredChainCommand {
  return { identity: { cluster: "localnet", genesisHash: GENESIS, programAddress: PROGRAM, scope: "USER",
    scopeId: "user_12345678", actorId: "user_12345678", operation: "REPLACE_ORDER",
    idempotencyKey: "replace-request-123", requestHash: "a".repeat(64), requestJson }, state: {
    id: "cmd_replace_123", status, revision, attemptCount: epoch ? 1 : 0, leaseEpoch: epoch,
    lease: leased ? { owner: "worker", tokenHash: "hash", epoch, expiresAt: new Date(now.getTime() + 300_000) } : null,
    lastErrorCode: null, lastErrorMessage: null, acceptedAt: now, preparedAt: null, signedAt: null,
    submittedAt: null, confirmedAt: null, finalizedAt: null, projectedAt: null, unknownSince: null },
  createdAt: now, updatedAt: now };
}
function fixture(initial: StoredChainCommand["state"]["status"] = "ACCEPTED") {
  let current = command(initial, initial === "ACCEPTED" ? 0 : 4);
  const events: string[] = [];
  const store = { load: vi.fn(async () => current),
    acquireLease: vi.fn(async () => (current = command(current.state.status, current.state.revision + 1,
      current.state.leaseEpoch + 1, true))),
    transition: vi.fn(async (_id: string, input: { to: StoredChainCommand["state"]["status"] }) =>
      (current = command(input.to, current.state.revision + 1, current.state.leaseEpoch,
        !["UNKNOWN", "FAILED_RETRYABLE", "FAILED_TERMINAL", "PROJECTED"].includes(input.to)))),
    appendSignedWireBeforeSend: vi.fn(async () => { events.push("journal");
      current = command("SIGNED", current.state.revision + 1, current.state.leaseEpoch, true);
      return { command: current, journal: {} as never }; }),
    loadLatestWireReference: vi.fn(async () => ({ transactionSignature: "1".repeat(64), lastValidBlockHeight: 99n })),
    publicStatus: vi.fn(async () => ({ id: current.state.id, operation: "REPLACE_ORDER", status: current.state.status,
      revision: current.state.revision, attemptCount: current.state.attemptCount, acceptedAt: now, preparedAt: null,
      signedAt: null, submittedAt: null, confirmedAt: null, finalizedAt: null, projectedAt: null,
      unknownSince: null, updatedAt: now })) };
  const base = { id: "lane_replace", key: { genesisHash: GENESIS, programAddress: PROGRAM,
    walletAddress: PARTICIPANT, chainMarketId: "7" }, revision: 0, leaseEpoch: 0, lease: null,
    createdAt: now, updatedAt: now };
  const laneStore = { loadOrCreate: vi.fn(async () => base), acquire: vi.fn(async () => ({ ...base, revision: 1,
    leaseEpoch: 1, lease: { owner: "worker", epoch: 1, expiresAt: new Date(now.getTime() + 300_000) } })),
  release: vi.fn(async () => ({ ...base, revision: 2, leaseEpoch: 1, lease: null })) };
  const signed = { version: 1 as const, cluster: "localnet" as const, genesisHash: GENESIS,
    programAddress: PROGRAM as Address, participantAddress: PARTICIPANT, sponsorAddress: SPONSOR,
    signature: "1".repeat(64), signedWireBase64: "wire" as never, messageSha256: "digest",
    recentBlockhash: SPONSOR, lastValidBlockHeight: 99n };
  const prepared = { signed, market: SPONSOR, book: SPONSOR, orderId: 42n, replacementOrderId: 50n,
    outcome: "YES" as const, action: "BUY" as const, price: 450n, quantity: 3n, expiresAt: null,
    expectedNonce: 5n, observedSlot: 40n, bookRevision: 9n };
  return { events, store, laneStore, signed, prepared };
}

describe("managed amendment dispatcher", () => {
  it("journals and submits exactly one signed atomic transaction, then proves finalized state", async () => {
    const f = fixture(), verify = vi.fn(async () => ({ finalizedSlot: 51n, nextNonce: 7n }));
    const result = await dispatchManagedAmendmentCommand("cmd_replace_123", { store: f.store, env, owner: "worker",
      now: () => now, laneStore: f.laneStore as never,
      loadParticipant: vi.fn(async () => createNoopSigner(PARTICIPANT)),
      loadSponsor: vi.fn(async () => createNoopSigner(SPONSOR)), prepare: vi.fn(async () => f.prepared),
      submit: vi.fn(async () => { f.events.push("submit"); return { status: "submitted" as const,
        signature: f.signed.signature, signedWireBase64: f.signed.signedWireBase64, lastValidBlockHeight: 99n }; }),
      track: vi.fn(async () => ({ status: "finalized" as const, signature: f.signed.signature, executionSlot: 50n })),
      verifyFinalized: verify });
    expect(result.status).toBe("FINALIZED");
    expect(f.events).toEqual(["journal", "submit"]);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ orderId: 42n, replacementOrderId: 50n,
      expectedNonce: 5n, minimumFinalizedSlot: 50n }));
    expect(f.laneStore.release).toHaveBeenCalledOnce();
  });

  it("never splits or replaces an ambiguous signed amendment", async () => {
    const f = fixture();
    const result = await dispatchManagedAmendmentCommand("cmd_replace_123", { store: f.store, env, owner: "worker",
      now: () => now, laneStore: f.laneStore as never,
      loadParticipant: vi.fn(async () => createNoopSigner(PARTICIPANT)),
      loadSponsor: vi.fn(async () => createNoopSigner(SPONSOR)), prepare: vi.fn(async () => f.prepared),
      submit: vi.fn(async () => ({ status: "unknown" as const, signature: f.signed.signature,
        signedWireBase64: f.signed.signedWireBase64, lastValidBlockHeight: 99n })) });
    expect(result.status).toBe("UNKNOWN");
    expect(f.store.appendSignedWireBeforeSend).toHaveBeenCalledOnce();
    expect(f.laneStore.release).not.toHaveBeenCalled();
  });
});

describe("finalized amendment proof", () => {
  const input = { runtime: { cluster: "localnet" as const, rpcUrl: env.GOOSEY_SOLANA_RPC_URL,
    programAddress: PROGRAM as Address, genesisHash: GENESIS }, walletAddress: PARTICIPANT, marketId: 7n,
    orderId: 42n, replacementOrderId: 50n, outcome: "YES" as const, action: "BUY" as const,
    price: 450n, quantity: 3n, expiresAt: null, expectedNonce: 5n, minimumFinalizedSlot: 50n };
  it("accepts a matching resting replacement and two consumed nonces", async () => {
    const read = vi.fn(async () => ({ wallet: PARTICIPANT, marketState: { marketId: 7n }, finalizedSlot: 50n,
      registered: true, seat: { index: 2, nextNonce: 7n }, orderBook: { reservesReconciled: true,
        nextSequence: 51n, orders: [{ id: 50n, wallet: PARTICIPANT, ownerSeat: 2, outcome: "YES", action: "BUY",
          limitPrice: 450n, remaining: 2n, expiresAt: null }] } } as never));
    await expect(verifyFinalizedManagedAmendment(input, { read })).resolves.toEqual({ finalizedSlot: 50n, nextNonce: 7n });
  });
  it("rejects a surviving original or only one consumed nonce", async () => {
    const base = { wallet: PARTICIPANT, marketState: { marketId: 7n }, finalizedSlot: 50n, registered: true,
      seat: { index: 2, nextNonce: 7n }, orderBook: { reservesReconciled: true, nextSequence: 51n, orders: [] } };
    await expect(verifyFinalizedManagedAmendment(input, { read: vi.fn(async () => ({ ...base,
      orderBook: { ...base.orderBook, orders: [{ id: 42n }] } } as never)) })).rejects.toThrow(/original/);
    await expect(verifyFinalizedManagedAmendment(input, { read: vi.fn(async () => ({ ...base,
      seat: { index: 2, nextNonce: 6n } } as never)) })).rejects.toThrow(/nonce/);
  });
});
