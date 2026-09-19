"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createSolanaRpc } from "@solana/kit";
import { apiFetch } from "@/lib/client-api";
import type { BrowserWalletSnapshot, createBrowserWallet } from "@/lib/solana/browser-wallet";
import { parsePublicBrowserRuntime } from "@/lib/solana/browser-runtime";
import { readGooseyConfiguration } from "@/lib/solana/configuration";
import type { SolanaRuntime } from "@/lib/solana/runtime";
import { submitSignedWalletTransaction, type TransferSubmission } from "@/lib/solana/submit-transfer";
import { createTransferReceiptStore } from "@/lib/solana/transfer-receipts";
import { trackTransactionStatus, type TransactionStatusResult } from "@/lib/solana/transaction-status";
import type { PreparedWalletTransaction } from "@/lib/solana/wallet-transaction";

type Receipt = Omit<TransferSubmission, "status">;
export type ChainTransactionReceipt = Receipt & Pick<TransactionStatusResult, "status" | "commitment" | "historicalOutcome">;
type State = { key: string; busy: string | null; error: string | null; receipts: ChainTransactionReceipt[]; ready: boolean };
type Commands = {
  key: string;
  submit: (prepared: PreparedWalletTransaction) => Promise<TransactionStatusResult | null>;
  recover: () => Promise<void>;
};
const terminal = (value: Pick<TransactionStatusResult, "status" | "commitment">) =>
  value.commitment === "finalized" && (value.status === "finalized" || value.status === "failed");
const message = (error: unknown) => error instanceof Error ? error.message : "The chain request could not be completed.";
const runtimeIdentity = (runtime: SolanaRuntime) => `${runtime.cluster}:${runtime.genesisHash}:${runtime.programAddress}:${runtime.rpcUrl}`;

/** Explicit submit only. The caller owns economic preparation and review, and
 * must discard its review when invoking submit. Recovery never signs or sends.
 * All wallet mutations share the wallet page's journal and cross-tab lock.
 */
export function useChainTransaction({ runtime, wallet, snapshot, onFinalized }: {
  runtime: SolanaRuntime;
  wallet: ReturnType<typeof createBrowserWallet>;
  snapshot: BrowserWalletSnapshot;
  onFinalized?: (receipt: ChainTransactionReceipt) => void | Promise<void>;
}) {
  const { cluster, genesisHash, programAddress, rpcUrl } = runtime;
  const account = snapshot.account?.address;
  const { generation, status } = snapshot;
  const key = `${runtimeIdentity(runtime)}:${account ?? ""}:${generation}:${status}`;
  const commands = useRef<Commands | null>(null);
  const finalizedCallback = useRef(onFinalized);
  const [state, setState] = useState<State>({ key: "", busy: null, error: null, receipts: [], ready: false });
  useEffect(() => { finalizedCallback.current = onFinalized; }, [onFinalized]);

  useEffect(() => {
    const lifetime = new AbortController();
    const runtime: SolanaRuntime = { cluster, genesisHash, programAddress, rpcUrl };
    const key = `${runtimeIdentity(runtime)}:${account ?? ""}:${generation}:${status}`;
    let running = false, rerun = false, available = false;
    let operation: AbortController | null = null;
    let receipts: ChainTransactionReceipt[] = [];
    const proven = new Set<string>();
    const attempted = new WeakSet<PreparedWalletTransaction>();
    const connected = Boolean(account) && status === "connected";
    const lockName = `goosey-wallet-send:${genesisHash}:${programAddress}:${account}`;
    const prefix = `goosey:transfer:v1:${cluster}:${genesisHash}:${programAddress}:${account}:`;
    const patch = (values: Partial<State>) => {
      if (!lifetime.signal.aborted) setState(previous => ({ ...previous, key, ...values }));
    };
    patch({ busy: null, error: null, receipts: [], ready: false });
    function unchanged(signal: AbortSignal) {
      signal.throwIfAborted(); lifetime.signal.throwIfAborted();
      const current = wallet.getSnapshot();
      if (!account || current.generation !== generation || current.account?.address !== account || current.status !== "connected") {
        throw new Error("Wallet changed. Select an account and prepare again.");
      }
    }
    const journal = () => {
      if (!account) throw new Error("Select a wallet account first.");
      return createTransferReceiptStore(window.localStorage, { cluster, genesisHash, programAddress, walletAddress: account });
    };
    async function verify(signal: AbortSignal) {
      unchanged(signal);
      const response = await apiFetch("/api/solana/status", { credentials: "same-origin", cache: "no-store", signal });
      if (!response.ok) throw new Error("On-chain availability could not be verified.");
      const current = parsePublicBrowserRuntime(await response.json());
      if (!current || runtimeIdentity(current) !== runtimeIdentity(runtime)) throw new Error("Wallet deployment changed or is unavailable. Reload before continuing.");
      await readGooseyConfiguration(runtime, signal);
      const rpc = createSolanaRpc(rpcUrl);
      if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== genesisHash) throw new Error("RPC network mismatch. Transactions are blocked.");
      unchanged(signal);
      return rpc;
    }
    async function verifyLink(signal: AbortSignal) {
      const response = await apiFetch("/api/solana/wallet", { credentials: "same-origin", cache: "no-store", signal });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? "Sign in and link this wallet on the Wallet page before trading."
        : "Wallet ownership link could not be verified.");
      const body: unknown = await response.json();
      const items = body && typeof body === "object" && "items" in body ? body.items : null;
      if (!Array.isArray(items) || !items.some(value => value && typeof value === "object"
        && value.walletAddress === account && value.chainId === `solana:${cluster}` && value.genesisHash === genesisHash)) {
        throw new Error("Sign in and link this wallet on the Wallet page before trading.");
      }
      unchanged(signal);
    }
    function observe(receipt: Receipt, result: Pick<TransactionStatusResult, "status" | "commitment" | "historicalOutcome">) {
      if (lifetime.signal.aborted) return;
      if (terminal(result)) proven.add(receipt.signature);
      else proven.delete(receipt.signature);
      receipts = [...receipts.filter(value => value.signature !== receipt.signature), { ...receipt, ...result }];
      patch({ receipts });
    }
    async function checkSaved(signal: AbortSignal) {
      const saved = await journal().list(); unchanged(signal);
      if (saved.unreadableKeys.length || saved.receipts.some(receipt => !proven.has(receipt.signature))) {
        available = false; patch({ ready: false });
        throw new Error("A saved transaction needs recovery before another transaction can be signed.");
      }
    }
    async function finalized(receipt: Receipt, result: TransactionStatusResult, signal: AbortSignal) {
      unchanged(signal);
      if (result.status === "finalized" && result.commitment === "finalized") {
        await finalizedCallback.current?.({ ...receipt, ...result }); unchanged(signal);
      }
    }
    async function run<T>(label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
      if (running || lifetime.signal.aborted || !connected) return null;
      running = true;
      const controller = new AbortController(); operation = controller;
      const signal = AbortSignal.any([controller.signal, lifetime.signal, AbortSignal.timeout(120_000)]);
      patch({ busy: label, error: null, ready: false });
      try { unchanged(signal); return await work(signal); }
      catch (error) {
        available = false;
        if (!lifetime.signal.aborted && !controller.signal.aborted) patch({ error: message(error) });
        return null;
      }
      finally {
        // Promise.all can reject while another receipt is still being read.
        // Stop those observers before a newer recovery can clear its proofs.
        controller.abort(); running = false; operation = null;
        patch({ busy: null, ready: available && receipts.every(receipt => proven.has(receipt.signature)) && Boolean(navigator.locks) });
        if (rerun && !lifetime.signal.aborted) { rerun = false; void recover(); }
      }
    }
    async function recover() {
      if (running) { rerun = true; return; }
      await run("Checking saved transactions…", async signal => {
        available = false; proven.clear();
        const saved = await journal().list(); unchanged(signal);
        receipts = saved.receipts.map(receipt => ({ ...receipt, status: "unknown" }));
        patch({ receipts });
        if (saved.unreadableKeys.length) throw new Error("A saved transaction receipt cannot be read. Recover it before signing another transaction.");
        const rpc = await verify(signal);
        await Promise.all(saved.receipts.map(async receipt => {
          const result = await trackTransactionStatus(rpc, { ...receipt, commitment: "finalized", signal,
            onObservation: result => { if (!signal.aborted) observe(receipt, result); } });
          unchanged(signal); observe(receipt, result);
          await finalized(receipt, result, signal);
        }));
        await verifyLink(signal);
        unchanged(signal); available = true;
        if (!navigator.locks) throw new Error("This browser cannot safely coordinate wallet submissions across tabs.");
      });
    }
    async function submit(prepared: PreparedWalletTransaction) {
      if (!available || receipts.some(receipt => !proven.has(receipt.signature))) {
        patch({ error: "Check saved transaction status before approving a new transaction." }); return null;
      }
      return run("Verifying transaction…", async signal => {
        if (!navigator.locks) throw new Error("This browser cannot safely coordinate wallet submissions across tabs.");
        return navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
          if (!lock) throw new Error("Another tab is using this wallet. Finish that request before continuing.");
          const rpc = await verify(signal); await verifyLink(signal); await checkSaved(signal);
          if (attempted.has(prepared)) throw new Error("This review was already submitted for signing. Prepare a new review after recovery.");
          if (prepared.sender !== account || prepared.cluster !== cluster || prepared.genesisHash !== genesisHash) throw new Error("Transaction does not match the selected wallet and deployment.");
          const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send({ abortSignal: signal });
          if (height > prepared.message.lifetimeConstraint.lastValidBlockHeight) throw new Error("Transaction review expired. Prepare it again.");
          unchanged(signal); attempted.add(prepared); patch({ busy: "Waiting for wallet approval…" });
          const signed = await wallet.signTransaction(prepared, signal); unchanged(signal);
          await verify(signal); await verifyLink(signal); await checkSaved(signal);
          patch({ busy: "Submitting signed transaction…" });
          const result = await submitSignedWalletTransaction({ runtime, prepared, signed, signal,
            onPrepared: async receipt => {
              unchanged(signal); await journal().persist(receipt);
              observe(receipt, { status: "unknown" }); unchanged(signal);
            } });
          unchanged(signal); observe(result, { status: result.status });
          patch({ busy: "Checking transaction finalization…" });
          const trackingRpc = await verify(signal);
          const observed = await trackTransactionStatus(trackingRpc, { ...result, commitment: "finalized", signal,
            onObservation: value => { if (!signal.aborted) observe(result, value); } });
          unchanged(signal); observe(result, observed);
          await finalized(result, observed, signal);
          return observed;
        });
      });
    }
    const current: Commands = { key, submit, recover }; commands.current = current;
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(prefix)) {
        available = false; proven.clear(); patch({ ready: false });
        if (running) { rerun = true; operation?.abort(); }
        else void recover();
      }
    };
    window.addEventListener("storage", storage);
    if (connected) void recover();
    return () => {
      lifetime.abort(); operation?.abort(); window.removeEventListener("storage", storage);
      if (commands.current === current) commands.current = null;
    };
  }, [cluster, genesisHash, programAddress, rpcUrl, wallet, account, generation, status]);

  const submit = useCallback((prepared: PreparedWalletTransaction) => {
    if (commands.current?.key !== key) return Promise.resolve(null);
    return commands.current.submit(prepared);
  }, [key]);
  const recover = useCallback(() => commands.current?.key === key ? commands.current.recover() : Promise.resolve(), [key]);
  const current = state.key === key;
  return { busy: current ? state.busy : null, error: current ? state.error : null,
    receipts: current ? state.receipts : [], ready: current && state.ready, submit, recover };
}
