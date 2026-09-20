import { createNoopSigner, type Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import type { StoredChainCommand } from "./chain-command-store";
import {
  dispatchManagedCancellationCommand,
  verifyFinalizedManagedCancellation,
} from "./managed-cancellation-dispatcher";

const PROGRAM = "Vote111111111111111111111111111111111111111";
const GENESIS = "Stake11111111111111111111111111111111111111";
const SPONSOR = "11111111111111111111111111111111" as Address;
const PARTICIPANT = "SysvarRent111111111111111111111111111111111" as Address;
const runtime = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: GENESIS };
const requestJson = JSON.stringify({ operation: "CANCEL_ORDER", request: { chainMarketId: "7",
  expectedVersion: 9, marketId: "market_1", marketSlug: "market-one", orderId: "42" }, version: 1 });
const clock = new Date("2026-09-20T00:00:01Z");

function stored(status: StoredChainCommand["state"]["status"], revision: number, leaseEpoch = 0,
  leased = leaseEpoch > 0): StoredChainCommand {
  const acceptedAt = new Date("2026-09-20T00:00:00Z");
  return { identity: { cluster: "localnet", genesisHash: GENESIS, programAddress: PROGRAM, scope: "USER",
    scopeId: "user_12345678", actorId: "user_12345678", operation: "CANCEL_ORDER",
    idempotencyKey: "cancel-request-123", requestHash: "a".repeat(64), requestJson },
  state: { id: "cmd_cancel_123", status, revision, attemptCount: leaseEpoch ? 1 : 0, leaseEpoch,
    lease: leased ? { owner: "worker", tokenHash: "hash", epoch: leaseEpoch,
      expiresAt: new Date(clock.getTime() + 300_000) } : null,
    lastErrorCode: null, lastErrorMessage: null, acceptedAt, preparedAt: null, signedAt: null,
    submittedAt: null, confirmedAt: null, finalizedAt: null, projectedAt: null, unknownSince: null },
  createdAt: acceptedAt, updatedAt: acceptedAt };
}

function fixture(initial: StoredChainCommand["state"]["status"] = "ACCEPTED") {
  let current = stored(initial, initial === "ACCEPTED" ? 0 : 4);
  const events: string[] = [];
  const store = {
    load: vi.fn(async () => current),
    acquireLease: vi.fn(async () => (current = stored(current.state.status, current.state.revision + 1,
      current.state.leaseEpoch + 1, true))),
    transition: vi.fn(async (_id: string, input: { to: StoredChainCommand["state"]["status"] }) => {
      current = stored(input.to, current.state.revision + 1, current.state.leaseEpoch,
        !["UNKNOWN", "FAILED_RETRYABLE", "FAILED_TERMINAL", "PROJECTED"].includes(input.to));
      return current;
    }),
    appendSignedWireBeforeSend: vi.fn(async () => {
      events.push("journal"); current = stored("SIGNED", current.state.revision + 1, current.state.leaseEpoch, true);
      return { command: current, journal: {} as never };
    }),
    loadLatestWireReference: vi.fn(async () => ({ transactionSignature: "1".repeat(64), lastValidBlockHeight: 99n })),
    publicStatus: vi.fn(async () => ({ id: current.state.id, operation: "CANCEL_ORDER",
      status: current.state.status, revision: current.state.revision, attemptCount: current.state.attemptCount,
      acceptedAt: current.state.acceptedAt, preparedAt: null, signedAt: null, submittedAt: null,
      confirmedAt: null, finalizedAt: null, projectedAt: null, unknownSince: null, updatedAt: current.updatedAt })),
  };
  const baseLane = { id: "lane_cancel_123", key: { genesisHash: GENESIS, programAddress: PROGRAM,
    walletAddress: PARTICIPANT, chainMarketId: "7" }, revision: 0, leaseEpoch: 0, lease: null,
    createdAt: clock, updatedAt: clock };
  const laneStore = {
    loadOrCreate: vi.fn(async () => baseLane),
    acquire: vi.fn(async () => ({ ...baseLane, revision: 1, leaseEpoch: 1,
      lease: { owner: "worker", epoch: 1, expiresAt: new Date(clock.getTime() + 300_000) } })),
    release: vi.fn(async () => ({ ...baseLane, revision: 2, leaseEpoch: 1, lease: null })),
  };
  const signed = { version: 1 as const, cluster: "localnet" as const, genesisHash: GENESIS,
    programAddress: PROGRAM as Address, participantAddress: PARTICIPANT, sponsorAddress: SPONSOR,
    signature: "1".repeat(64), signedWireBase64: "wire" as never, messageSha256: "digest",
    recentBlockhash: SPONSOR, lastValidBlockHeight: 99n };
  return { events, store, laneStore, signed };
}

describe("managed cancellation dispatcher", () => {
  it("journals before submission, uses the wallet/market lane, and proves finalized post-state", async () => {
    const f = fixture();
    const verifyFinalized = vi.fn(async () => ({ finalizedSlot: 51n, nextNonce: 6n }));
    const submit = vi.fn(async () => { f.events.push("submit"); return { status: "submitted" as const,
      signature: f.signed.signature, signedWireBase64: f.signed.signedWireBase64, lastValidBlockHeight: 99n }; });
    const track = vi.fn(async () => ({ status: "finalized" as const, signature: f.signed.signature,
      executionSlot: 50n }));
    const result = await dispatchManagedCancellationCommand("cmd_cancel_123", { store: f.store, env: runtime,
      owner: "worker", now: () => clock, laneStore: f.laneStore as never,
      loadParticipant: vi.fn(async () => createNoopSigner(PARTICIPANT)),
      loadSponsor: vi.fn(async () => createNoopSigner(SPONSOR)),
      prepare: vi.fn(async () => ({ signed: f.signed, market: SPONSOR, book: SPONSOR,
        orderId: 42n, expectedNonce: 5n, observedSlot: 40n, bookRevision: 9n })),
      submit, track, verifyFinalized });
    expect(f.events).toEqual(["journal", "submit"]);
    expect(result.status).toBe("FINALIZED");
    expect(f.laneStore.acquire).toHaveBeenCalledWith(expect.objectContaining({ walletAddress: PARTICIPANT,
      chainMarketId: "7", expectedRevision: 0 }));
    expect(verifyFinalized).toHaveBeenCalledWith(expect.objectContaining({ orderId: 42n,
      minimumFinalizedSlot: 50n, expectedNonce: 5n }));
    expect(track).toHaveBeenCalledWith({ signature: f.signed.signature, lastValidBlockHeight: 99n,
      signal: undefined });
    expect(f.laneStore.release).toHaveBeenCalledOnce();
  });

  it("keeps the lane leased and exact wire recoverable after an ambiguous send", async () => {
    const f = fixture();
    const result = await dispatchManagedCancellationCommand("cmd_cancel_123", { store: f.store, env: runtime,
      owner: "worker", now: () => clock, laneStore: f.laneStore as never,
      loadParticipant: vi.fn(async () => createNoopSigner(PARTICIPANT)),
      loadSponsor: vi.fn(async () => createNoopSigner(SPONSOR)),
      prepare: vi.fn(async () => ({ signed: f.signed, market: SPONSOR, book: SPONSOR,
        orderId: 42n, expectedNonce: 5n, observedSlot: 40n, bookRevision: 9n })),
      submit: vi.fn(async () => ({ status: "unknown" as const, signature: f.signed.signature,
        signedWireBase64: f.signed.signedWireBase64, lastValidBlockHeight: 99n })) });
    expect(result.status).toBe("UNKNOWN");
    expect(f.store.appendSignedWireBeforeSend).toHaveBeenCalledOnce();
    expect(f.laneStore.release).not.toHaveBeenCalled();
  });

  it("reconciles UNKNOWN using only its exact journaled signature and finalized state", async () => {
    const f = fixture("UNKNOWN");
    const prepare = vi.fn(), submit = vi.fn();
    const verifyFinalized = vi.fn(async () => ({ finalizedSlot: 51n, nextNonce: 6n }));
    const result = await dispatchManagedCancellationCommand("cmd_cancel_123", { store: f.store as never,
      env: runtime, owner: "worker", now: () => clock, laneStore: f.laneStore as never,
      loadParticipant: vi.fn(async () => createNoopSigner(PARTICIPANT)), prepare, submit,
      track: vi.fn(async () => ({ status: "finalized" as const, signature: f.signed.signature,
        executionSlot: 50n })), verifyFinalized });
    expect(result.status).toBe("FINALIZED");
    expect(f.store.loadLatestWireReference).toHaveBeenCalledWith("cmd_cancel_123");
    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(verifyFinalized).toHaveBeenCalledWith(expect.not.objectContaining({ expectedNonce: expect.anything() }));
  });
});

describe("finalized cancellation proof", () => {
  const snapshot = { wallet: PARTICIPANT, marketState: { marketId: 7n }, finalizedSlot: 50n,
    registered: true, seat: { nextNonce: 6n }, orderBook: { reservesReconciled: true, orders: [] } };

  it("requires exact order absence and the fresh-path owner nonce increment", async () => {
    await expect(verifyFinalizedManagedCancellation({ runtime: { cluster: "localnet", rpcUrl: runtime.GOOSEY_SOLANA_RPC_URL,
      programAddress: PROGRAM as Address, genesisHash: GENESIS }, walletAddress: PARTICIPANT, marketId: 7n,
      orderId: 42n, minimumFinalizedSlot: 50n, expectedNonce: 5n }, {
      read: vi.fn(async () => snapshot as never),
    })).resolves.toEqual({ finalizedSlot: 50n, nextNonce: 6n });
  });

  it("rejects an order that still rests or a nonce that does not prove this owner mutation", async () => {
    const input = { runtime: { cluster: "localnet" as const, rpcUrl: runtime.GOOSEY_SOLANA_RPC_URL,
      programAddress: PROGRAM as Address, genesisHash: GENESIS }, walletAddress: PARTICIPANT, marketId: 7n,
      orderId: 42n, minimumFinalizedSlot: 50n, expectedNonce: 5n };
    await expect(verifyFinalizedManagedCancellation(input, { read: vi.fn(async () => ({ ...snapshot,
      orderBook: { reservesReconciled: true, orders: [{ id: 42n }] } } as never)) })).rejects.toThrow(/not removed/);
    await expect(verifyFinalizedManagedCancellation(input, { read: vi.fn(async () => ({ ...snapshot,
      seat: { nextNonce: 7n } } as never)) })).rejects.toThrow(/nonce/);
  });
});
