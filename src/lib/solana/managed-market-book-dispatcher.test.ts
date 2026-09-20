import { createNoopSigner, type Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import type { StoredChainCommand } from "./chain-command-store";
import { dispatchManagedMarketBookCommand } from "./managed-market-book-dispatcher";

const PROGRAM = "Vote111111111111111111111111111111111111111";
const GENESIS = "Stake11111111111111111111111111111111111111";
const AUTHORITY = "11111111111111111111111111111111" as Address;
const MARKET = "SysvarC1ock11111111111111111111111111111111" as Address;
const BOOK = "SysvarRent111111111111111111111111111111111" as Address;
const env = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: GENESIS };
const requestJson = JSON.stringify({ operation: "PROVISION_MARKET_BOOK", request: {
  provisioningVersion: 1, marketId: "market_12345678", marketSlug: "market-one",
  chainMarketId: "7", marketAddress: MARKET, step: { kind: "create" },
}, version: 1 });

function stored(status: StoredChainCommand["state"]["status"], revision: number, leaseEpoch = 0): StoredChainCommand {
  const date = new Date("2026-09-20T00:00:00Z");
  return { identity: { cluster: "localnet", genesisHash: GENESIS, programAddress: PROGRAM, scope: "MARKET",
    scopeId: "market_12345678", actorId: "admin_12345678", operation: "PROVISION_MARKET_BOOK",
    idempotencyKey: "managed-market-book:v1:create", requestHash: "a".repeat(64), requestJson },
  state: { id: "command_book_123", status, revision, attemptCount: leaseEpoch ? 1 : 0, leaseEpoch,
    lease: leaseEpoch ? { owner: "worker", tokenHash: "hash", epoch: leaseEpoch,
      expiresAt: new Date(date.getTime() + 300_000) } : null,
    lastErrorCode: null, lastErrorMessage: null, acceptedAt: date, preparedAt: null, signedAt: null,
    submittedAt: null, confirmedAt: null,
    finalizedAt: ["FINALIZED", "PROJECTED"].includes(status) ? date : null,
    projectedAt: status === "PROJECTED" ? date : null, unknownSince: null },
  createdAt: date, updatedAt: date };
}

function fixture(initial: StoredChainCommand["state"]["status"] = "ACCEPTED") {
  let current = stored(initial, 0);
  const events: string[] = [];
  const store = {
    load: vi.fn(async () => current),
    loadLatestWireReference: vi.fn(async () => ({ transactionSignature: "1".repeat(64), lastValidBlockHeight: 99n })),
    acquireLease: vi.fn(async () => (current = stored(current.state.status, current.state.revision + 1, 1))),
    transition: vi.fn(async (_id: string, input: { to: StoredChainCommand["state"]["status"] }) => {
      events.push(input.to);
      current = stored(input.to, current.state.revision + 1,
        ["UNKNOWN", "FAILED_RETRYABLE", "FAILED_TERMINAL", "PROJECTED"].includes(input.to) ? 0 : 1);
      return current;
    }),
    appendSignedWireBeforeSend: vi.fn(async () => {
      events.push("JOURNAL"); current = stored("SIGNED", current.state.revision + 1, 1);
      return { command: current, journal: {} as never };
    }),
    publicStatus: vi.fn(async () => ({ id: current.state.id, operation: "PROVISION_MARKET_BOOK",
      status: current.state.status, revision: current.state.revision, attemptCount: current.state.attemptCount,
      acceptedAt: current.state.acceptedAt, preparedAt: null, signedAt: null, submittedAt: null,
      confirmedAt: null, finalizedAt: null, projectedAt: null, unknownSince: null, updatedAt: current.updatedAt })),
  };
  const receipt = { signature: "1".repeat(64), signedWireBase64: "wire" as never,
    lastValidBlockHeight: 99n, recentBlockhash: AUTHORITY, authorityAddress: AUTHORITY };
  const signed = { signatures: { [AUTHORITY]: new Uint8Array(64) }, messageBytes: new Uint8Array() } as never;
  const dependencies = { store, env, database: {} as never, owner: "worker",
    now: () => new Date("2026-09-20T00:00:01Z"),
    loadAuthority: vi.fn(async () => createNoopSigner(AUTHORITY)),
    prepare: vi.fn(async () => ({ receipt, signed, prepared: {} as never, market: MARKET, book: BOOK,
      observed: { book: BOOK, ready: false, size: 0, finalizedSlot: 1n } })),
    submit: vi.fn(async () => {
      events.push("SUBMIT"); return { status: "submitted" as const,
        signature: receipt.signature, signedWireBase64: receipt.signedWireBase64, lastValidBlockHeight: 99n };
    }),
    track: vi.fn(async () => ({ status: "finalized" as const, signature: receipt.signature, executionSlot: 44n })),
    project: vi.fn(async () => { events.push("PROJECT"); }),
  };
  return { store, events, dependencies, receipt };
}

describe("managed market book dispatcher", () => {
  it("journals the exact authority-signed wire before send and projects only after finality", async () => {
    const f = fixture();
    const result = await dispatchManagedMarketBookCommand("command_book_123", f.dependencies as never);
    expect(result.status).toBe("PROJECTED");
    expect(f.events).toEqual(["PREPARED", "JOURNAL", "SUBMIT", "SUBMITTED", "FINALIZED", "PROJECT", "PROJECTED"]);
    expect(f.store.appendSignedWireBeforeSend).toHaveBeenCalledWith(expect.objectContaining({ wire: expect.objectContaining({
      feePayerAddress: AUTHORITY, signerAddresses: [AUTHORITY], sequence: 1,
      signedWireBase64: f.receipt.signedWireBase64,
    }) }));
    expect(f.dependencies.project).toHaveBeenCalledWith(expect.anything(), 44n, undefined);
  });

  it.each(["SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN"] as const)(
    "reconciles retained %s wire without preparing or submitting a replacement",
    async status => {
      const f = fixture(status);
      expect((await dispatchManagedMarketBookCommand("command_book_123", f.dependencies as never)).status).toBe("PROJECTED");
      expect(f.dependencies.prepare).not.toHaveBeenCalled();
      expect(f.dependencies.submit).not.toHaveBeenCalled();
      expect(f.dependencies.project).toHaveBeenCalledOnce();
    },
  );

  it("moves a post-journal transport failure to UNKNOWN", async () => {
    const f = fixture();
    f.dependencies.submit.mockRejectedValueOnce(new Error("transport failed"));
    await expect(dispatchManagedMarketBookCommand("command_book_123", f.dependencies as never)).rejects.toThrow("transport failed");
    expect(f.events).toEqual(["PREPARED", "JOURNAL", "UNKNOWN"]);
  });

  it("keeps pre-sign failures retryable and emits no wire journal", async () => {
    const f = fixture();
    f.dependencies.loadAuthority.mockRejectedValueOnce(new Error("authority unavailable"));
    await expect(dispatchManagedMarketBookCommand("command_book_123", f.dependencies as never)).rejects.toThrow("authority unavailable");
    expect(f.events).toEqual(["PREPARED", "FAILED_RETRYABLE"]);
    expect(f.store.appendSignedWireBeforeSend).not.toHaveBeenCalled();
  });

  it("resumes projection from FINALIZED without signing a second economic intent", async () => {
    const f = fixture("FINALIZED");
    expect((await dispatchManagedMarketBookCommand("command_book_123", f.dependencies as never)).status).toBe("PROJECTED");
    expect(f.events).toEqual(["PROJECT", "PROJECTED"]);
    expect(f.dependencies.prepare).not.toHaveBeenCalled();
    expect(f.dependencies.submit).not.toHaveBeenCalled();
  });
});
