import { describe, expect, it, vi } from "vitest";

import { ChainCommandConflictError } from "./chain-command-state";
import {
  managedCommandWorkerConfigFromEnvironment,
  runManagedCommandWorker,
  runManagedCommandWorkerCycle,
} from "./managed-command-worker";

const PROGRAM = "Vote111111111111111111111111111111111111111";
const GENESIS = "Stake11111111111111111111111111111111111111";
const env = {
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM,
  GOOSEY_SOLANA_GENESIS_HASH: GENESIS,
};
const expired = new Date("2026-09-20T00:00:00Z");
const now = new Date("2026-09-20T00:10:00Z");

function candidate(id: string, operation: string, status = "ACCEPTED") {
  return { id, operation, status, leaseExpiresAt: expired };
}

function queueFor(rows: Record<string, ReturnType<typeof candidate>[]>) {
  return {
    findMany: vi.fn(async ({ where }: { where: { operation: string } }) => rows[where.operation] ?? []),
  };
}

describe("managed Solana command worker", () => {
  it("recovers an expired signed order after restart without creating a new intent", async () => {
    const queue = queueFor({ PLACE_ORDER: [candidate("order_12345678", "PLACE_ORDER", "SIGNED")] });
    const dispatchOrder = vi.fn(async () => ({ status: "FINALIZED" } as never));
    const result = await runManagedCommandWorkerCycle({
      queue: queue as never,
      database: {} as never,
      env,
      owner: "worker-restarted",
      now: () => now,
      dispatchOrder,
      dispatchMarket: vi.fn(),
      dispatchSeat: vi.fn(),
      dispatchEscrow: vi.fn(),
    });

    expect(result).toEqual({ selected: 1, attempted: 1, completed: 1, pending: 0,
      uncertain: 0, terminalFailures: 0, contended: 0, failed: 0, stoppedEarly: false });
    expect(dispatchOrder).toHaveBeenCalledOnce();
    expect(dispatchOrder).toHaveBeenCalledWith("order_12345678", expect.objectContaining({
      database: {}, env, owner: "worker-restarted",
    }));
    expect(queue.findMany).toHaveBeenCalledTimes(12);
    expect(queue.findMany.mock.calls[4]?.[0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({ cluster: "localnet", genesisHash: GENESIS,
        programAddress: PROGRAM, operation: "PLACE_ORDER" }),
      take: 25,
    }));
  });

  it("dispatches durable cancellation and feather-transfer commands", async () => {
    const queue = queueFor({
      CANCEL_ORDER: [candidate("cancel_12345678", "CANCEL_ORDER")],
      TRANSFER_FEATHERS: [candidate("transfer_12345678", "TRANSFER_FEATHERS")],
    });
    const dispatchCancellation = vi.fn(async () => ({ status: "FINALIZED" } as never));
    const dispatchTransfer = vi.fn(async () => ({ status: "PROJECTED" } as never));

    const result = await runManagedCommandWorkerCycle({
      queue: queue as never,
      database: {} as never,
      env,
      now: () => now,
      dispatchMarket: vi.fn(),
      dispatchSeat: vi.fn(),
      dispatchEscrow: vi.fn(),
      dispatchOrder: vi.fn(),
      dispatchCancellation,
      dispatchTransfer,
    });

    expect(dispatchCancellation).toHaveBeenCalledWith("cancel_12345678", expect.any(Object));
    expect(dispatchTransfer).toHaveBeenCalledWith("transfer_12345678", expect.any(Object));
    expect(result).toEqual(expect.objectContaining({ selected: 2, attempted: 2, completed: 2 }));
  });

  it("runs durable child commands before their parent order", async () => {
    const queue = queueFor({
      REGISTER_SEAT: [candidate("seat_12345678", "REGISTER_SEAT")],
      DEPOSIT_ESCROW: [candidate("escrow_12345678", "DEPOSIT_ESCROW")],
      PLACE_ORDER: [candidate("order_12345678", "PLACE_ORDER")],
    });
    const events: string[] = [];
    const dispatchSeat = vi.fn(async () => { events.push("seat"); return { status: "PROJECTED" } as never; });
    const dispatchEscrow = vi.fn(async () => { events.push("escrow"); return { status: "FINALIZED" } as never; });
    const dispatchOrder = vi.fn(async () => { events.push("order"); return { status: "FINALIZED" } as never; });

    const result = await runManagedCommandWorkerCycle({ queue: queue as never, database: {} as never,
      env, now: () => now, dispatchMarket: vi.fn(), dispatchSeat, dispatchEscrow, dispatchOrder });

    expect(events).toEqual(["seat", "escrow", "order"]);
    expect(result.completed).toBe(3);
  });

  it("relies on dispatcher CAS leases so racing workers produce one economic attempt", async () => {
    const queue = queueFor({ PLACE_ORDER: [candidate("order_12345678", "PLACE_ORDER")] });
    let leaseClaimed = false;
    let economicAttempts = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const dispatchOrder = vi.fn(async () => {
      if (leaseClaimed) throw new ChainCommandConflictError();
      leaseClaimed = true;
      economicAttempts += 1;
      await gate;
      return { status: "FINALIZED" } as never;
    });
    const dependencies = { queue: queue as never, database: {} as never, env, now: () => now,
      dispatchOrder, dispatchMarket: vi.fn(), dispatchSeat: vi.fn(), dispatchEscrow: vi.fn() };
    const first = runManagedCommandWorkerCycle({ ...dependencies, owner: "worker-one" });
    const second = runManagedCommandWorkerCycle({ ...dependencies, owner: "worker-two" });
    await vi.waitFor(() => expect(dispatchOrder).toHaveBeenCalledTimes(2));
    release();
    const results = await Promise.all([first, second]);

    expect(economicAttempts).toBe(1);
    expect(results.reduce((sum, result) => sum + result.completed, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.contended, 0)).toBe(1);
  });

  it("stops taking commands on shutdown while allowing the in-flight dispatch to finish", async () => {
    const controller = new AbortController();
    const queue = queueFor({ PLACE_ORDER: [candidate("order_12345678", "PLACE_ORDER")] });
    let finish!: () => void;
    const inFlight = new Promise<void>(resolve => { finish = resolve; });
    const dispatchOrder = vi.fn(async () => {
      controller.abort();
      await inFlight;
      return { status: "FINALIZED" } as never;
    });
    const sleep = vi.fn(async () => undefined);
    const running = runManagedCommandWorker({ signal: controller.signal, queue: queue as never,
      database: {} as never, env, now: () => now, dispatchOrder,
      dispatchMarket: vi.fn(), dispatchSeat: vi.fn(), dispatchEscrow: vi.fn(), sleep });
    await vi.waitFor(() => expect(dispatchOrder).toHaveBeenCalledOnce());
    expect(queue.findMany).toHaveBeenCalledTimes(12);
    finish();
    await running;

    expect(dispatchOrder).toHaveBeenCalledOnce();
    expect(queue.findMany).toHaveBeenCalledTimes(12);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("bounds runtime configuration and backs failed retryables off in the query", async () => {
    expect(managedCommandWorkerConfigFromEnvironment({
      GOOSEY_CHAIN_WORKER_POLL_MS: "1000",
      GOOSEY_CHAIN_WORKER_MAX_BACKOFF_MS: "5000",
      GOOSEY_CHAIN_WORKER_RETRY_COOLDOWN_MS: "9000",
      GOOSEY_CHAIN_WORKER_BATCH_SIZE: "7",
    })).toEqual({ pollIntervalMs: 1000, maxBackoffMs: 5000, retryCooldownMs: 9000,
      perOperationBatchSize: 7 });
    expect(() => managedCommandWorkerConfigFromEnvironment({ GOOSEY_CHAIN_WORKER_BATCH_SIZE: "101" }))
      .toThrow(/1 to 100/);

    const queue = queueFor({});
    await runManagedCommandWorkerCycle({ queue: queue as never, database: {} as never,
      env, now: () => now, retryCooldownMs: 9_000 });
    const query = queue.findMany.mock.calls[0]?.[0] as unknown as { where: { AND: unknown[] } };
    expect(query.where.AND).toContainEqual({ OR: [
      { status: { in: ["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN", "FINALIZED"] } },
      { status: "FAILED_RETRYABLE", updatedAt: { lte: new Date("2026-09-20T00:09:51Z") } },
    ] });
    const participantQuery = queue.findMany.mock.calls[2]?.[0] as unknown as { where: { AND: unknown[] } };
    expect(participantQuery.where.AND).toContainEqual({ OR: [
      { status: { in: ["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED"] } },
      { status: "FAILED_RETRYABLE", updatedAt: { lte: new Date("2026-09-20T00:09:51Z") } },
    ] });
  });

  it.each(["SIGNED", "UNKNOWN", "FINALIZED"])("resumes %s market provisioning before dependent participant commands", async marketStatus => {
    const queue = queueFor({
      PROVISION_MARKET: [candidate("market_12345678", "PROVISION_MARKET", marketStatus)],
      PROVISION_MARKET_BOOK: [candidate("book_12345678", "PROVISION_MARKET_BOOK", marketStatus)],
      REGISTER_SEAT: [candidate("seat_12345678", "REGISTER_SEAT")],
      PLACE_ORDER: [candidate("order_12345678", "PLACE_ORDER")],
    });
    const events: string[] = [];
    const dispatchMarket = vi.fn(async () => { events.push("market"); return { status: "PROJECTED" } as never; });
    const dispatchBook = vi.fn(async () => { events.push("book"); return { status: "PROJECTED" } as never; });
    const dispatchSeat = vi.fn(async () => { events.push("seat"); return { status: "PROJECTED" } as never; });
    const dispatchOrder = vi.fn(async () => { events.push("order"); return { status: "UNKNOWN" } as never; });
    const result = await runManagedCommandWorkerCycle({ queue: queue as never, database: {} as never,
      env, now: () => now, dispatchMarket, dispatchBook, dispatchSeat, dispatchEscrow: vi.fn(), dispatchOrder });

    expect(events).toEqual(["market", "book", "seat", "order"]);
    expect(dispatchMarket).toHaveBeenCalledWith("market_12345678", expect.any(Object));
    expect(dispatchBook).toHaveBeenCalledWith("book_12345678", expect.any(Object));
    expect(result).toEqual(expect.objectContaining({ selected: 4, attempted: 4, completed: 3, uncertain: 1 }));
    expect(queue.findMany.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({ operation: "PROVISION_MARKET" }),
    }));
  });

  it("dispatches resolution commands in lifecycle order and reconciles retained UNKNOWN wire", async () => {
    const queue = queueFor({
      CLOSE_RESOLUTION: [candidate("close_12345678", "CLOSE_RESOLUTION")],
      PROPOSE_RESOLUTION: [candidate("propose_12345678", "PROPOSE_RESOLUTION")],
      APPROVE_RESOLUTION: [candidate("approve_12345678", "APPROVE_RESOLUTION", "UNKNOWN")],
      CLAIM_RESOLUTION: [candidate("claim_12345678", "CLAIM_RESOLUTION", "SIGNED")],
      FINALIZE_RESOLUTION: [candidate("finalize_12345678", "FINALIZE_RESOLUTION")],
    });
    const events: string[] = [];
    const dispatchResolution = vi.fn(async (commandId: string) => {
      events.push(commandId.split("_")[0]!);
      return { status: commandId.startsWith("claim") ? "UNKNOWN" : "PROJECTED" } as never;
    });

    const result = await runManagedCommandWorkerCycle({ queue: queue as never, database: {} as never,
      env, now: () => now, dispatchResolution });

    expect(events).toEqual(["close", "propose", "approve", "claim", "finalize"]);
    expect(dispatchResolution).toHaveBeenCalledTimes(5);
    expect(result).toEqual(expect.objectContaining({ selected: 5, attempted: 5, completed: 4, uncertain: 1 }));
    const approveQuery = queue.findMany.mock.calls[9]?.[0] as unknown as { where: { AND: unknown[] } };
    expect(approveQuery.where.AND).toContainEqual({ OR: [
      { status: { in: ["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN"] } },
      { status: "FAILED_RETRYABLE", updatedAt: { lte: new Date("2026-09-20T00:09:55Z") } },
    ] });
  });

  it("caps polling backoff and reports only a bounded error type", async () => {
    const controller = new AbortController();
    const onCycleError = vi.fn((event: { retryInMs: number }) => {
      expect(event.retryInMs).toBe(1_500);
      controller.abort();
    });
    await runManagedCommandWorker({
      signal: controller.signal,
      queue: { findMany: vi.fn(async () => { throw new TypeError("sensitive database detail"); }) } as never,
      database: {} as never,
      env,
      pollIntervalMs: 1_000,
      maxBackoffMs: 1_500,
      random: () => 1,
      onCycleError,
    });
    expect(onCycleError).toHaveBeenCalledWith({ errorType: "TypeError", consecutiveFailures: 1, retryInMs: 1_500 });
  });
});
