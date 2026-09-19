"use client";

import { useEffect, useId, useRef, useState } from "react";
import { address, compileTransaction, createSolanaRpc, getBase64Decoder, type TransactionMessageBytesBase64 } from "@solana/kit";
import { ChevronDown, LoaderCircle, RefreshCw, Wallet } from "lucide-react";
import { apiFetch } from "@/lib/client-api";
import { createBrowserWallet, type BrowserWalletSnapshot } from "@/lib/solana/browser-wallet";
import { parsePublicBrowserRuntime } from "@/lib/solana/browser-runtime";
import { readGooseyConfiguration } from "@/lib/solana/configuration";
import { readGooseyWalletBalance } from "@/lib/solana/wallet-balance";
import { buildClaimFeathersInstructions } from "@/lib/solana/program-client";
import { prepareFeatherClaim } from "@/lib/solana/prepare-feather-claim";
import { prepareFeatherTransfer } from "@/lib/solana/prepare-transfer";
import { submitSignedWalletTransaction, type TransferSubmission } from "@/lib/solana/submit-transfer";
import { createTransferReceiptStore } from "@/lib/solana/transfer-receipts";
import { trackTransactionStatus, type TransactionStatus } from "@/lib/solana/transaction-status";
import type { WalletChallenge } from "@/lib/solana/wallet-challenge";
import type { SolanaRuntime } from "@/lib/solana/runtime";
import styles from "./solana-wallet.module.css";

type Adapter = ReturnType<typeof createBrowserWallet>;
type Balance = Awaited<ReturnType<typeof readGooseyWalletBalance>>;
type Receipt = Omit<TransferSubmission, "status">;
type Recovery = Receipt & { status: TransactionStatus };
type LinkRecord = { walletAddress: string; chainId: string; genesisHash: string; verifiedAt: string };
type ErrorScope = "balance" | "link" | "claim" | "send" | "review";
type Review = ({ kind: "claim"; transaction: Awaited<ReturnType<typeof prepareFeatherClaim>> }
  | { kind: "send"; transaction: Awaited<ReturnType<typeof prepareFeatherTransfer>> }) & { fee: bigint; rent: bigint };
const settled = (status: TransactionStatus) => status === "finalized" || status === "failed";
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : "The request could not be completed.";
function amount(value: bigint, places = 3) {
  const unit = 10n ** BigInt(places);
  const fraction = (value % unit).toString().padStart(places, "0").replace(/0+$/, "");
  return `${(value / unit).toLocaleString("en-CA")}${fraction ? `.${fraction}` : ""}`;
}
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? "The wallet request could not be completed.");
  return body as T;
}
function runtimeKey(runtime: SolanaRuntime) {
  return `${runtime.cluster}:${runtime.genesisHash}:${runtime.programAddress}:${runtime.rpcUrl}`;
}
async function enabledRuntime(signal: AbortSignal, expected?: SolanaRuntime) {
  const runtime = parsePublicBrowserRuntime(await json<unknown>("/api/solana/status", { signal }));
  if (!runtime) throw new Error("On-chain wallet access is not enabled for this deployment.");
  if (expected && runtimeKey(runtime) !== runtimeKey(expected)) throw new Error("Wallet deployment changed. Reload this page before continuing.");
  await readGooseyConfiguration(runtime, signal);
  return runtime;
}

export function SolanaWallet() {
  const [runtime, setRuntime] = useState<SolanaRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    enabledRuntime(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
      .then(value => { if (!controller.signal.aborted) { setRuntime(value); setError(null); } })
      .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [attempt]);
  if (!runtime) return <section className={styles.panel} aria-label="Wallet availability">
    {error ? <><p role="alert">{error}</p><button className="button button-secondary" onClick={() => { setError(null); setAttempt(value => value + 1); }}>Check availability</button></> : <p role="status">Verifying the on-chain wallet connection…</p>}
  </section>;
  return <WalletConnection runtime={runtime} key={runtimeKey(runtime)} />;
}

function WalletConnection({ runtime }: { runtime: SolanaRuntime }) {
  const [connection, setConnection] = useState<{ wallet: Adapter; snapshot: BrowserWalletSnapshot } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const pending = useRef(false);
  const mounted = useRef<AbortController | null>(null);
  const accountId = useId();
  useEffect(() => {
    const controller = new AbortController(); mounted.current = controller;
    const wallet = createBrowserWallet({ chain: `solana:${runtime.cluster}`, genesisHash: runtime.genesisHash });
    const update = () => setConnection({ wallet, snapshot: wallet.getSnapshot() });
    const unsubscribe = wallet.subscribe(update); update();
    return () => { controller.abort(); unsubscribe(); wallet.dispose(); };
  }, [runtime.cluster, runtime.genesisHash]);
  async function connect(candidate: BrowserWalletSnapshot["wallets"][number]) {
    if (!connection || pending.current) return;
    pending.current = true; setConnecting(true); setError(null);
    try {
      await enabledRuntime(AbortSignal.any([mounted.current!.signal, AbortSignal.timeout(15_000)]), runtime);
      mounted.current!.signal.throwIfAborted();
      await connection.wallet.connect(candidate);
    } catch (reason) { if (!mounted.current?.signal.aborted) setError(errorMessage(reason)); }
    finally { pending.current = false; if (!mounted.current?.signal.aborted) setConnecting(false); }
  }
  return <div className={styles.root}>
    <section className={styles.panel}>
      <div className={styles.heading}><h2><Wallet aria-hidden="true" /> On-chain wallet</h2><span className={styles.network}>{runtime.cluster}</span></div>
      <p>These wallet feathers are separate from your Goosey account balance. Feathers are free play money and cannot be redeemed for cash.</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!connection ? <p role="status">Looking for compatible wallets…</p> : <>
        {connection.snapshot.status === "disconnected" && <>
          {connection.snapshot.wallets.length ? <div className={styles.actions}>{connection.snapshot.wallets.map((candidate, index) => <button type="button" className="button button-primary" disabled={connecting} key={`${candidate.name}-${index}`} onClick={() => void connect(candidate)}>Connect {candidate.name}</button>)}</div>
            : <p>No compatible wallet was found. Open a Wallet Standard wallet that supports {runtime.cluster}, message signing, and version 0 transactions. Wallets appear here when available.</p>}
        </>}
        {(connecting || connection.snapshot.status === "connecting") && <p role="status">Approve the connection in your wallet…</p>}
        {connection.snapshot.status === "connected" && <>
          <div className={styles.actions}><strong>{connection.snapshot.wallet?.name}</strong><button className="button button-secondary" type="button" onClick={() => { setError(null); void connection.wallet.disconnect().catch(reason => setError(errorMessage(reason))); }}>Disconnect</button></div>
          <label htmlFor={accountId}>Wallet account</label>
          <div className={styles.select}><select id={accountId} value={connection.snapshot.account?.address ?? ""} onChange={event => { setError(null); try { connection.wallet.selectAccount(event.target.value); } catch (reason) { setError(errorMessage(reason)); } }}>
            <option value="" disabled>Select an account</option>{connection.snapshot.accounts.map(account => <option key={account.address} value={account.address}>{account.label ? `${account.label} · ` : ""}{account.address}</option>)}
          </select><ChevronDown aria-hidden="true" /></div>
          {!connection.snapshot.accounts.length && <p>This wallet has no account with the required {runtime.cluster} signing capabilities.</p>}
        </>}
      </>}
    </section>
    {connection?.snapshot.account && connection.snapshot.status === "connected" && <WalletAccount key={`${connection.snapshot.generation}:${connection.snapshot.account.address}`} runtime={runtime} wallet={connection.wallet} snapshot={connection.snapshot} />}
  </div>;
}

function WalletAccount({ runtime, wallet, snapshot }: { runtime: SolanaRuntime; wallet: Adapter; snapshot: BrowserWalletSnapshot }) {
  const account = snapshot.account!.address;
  const id = useId();
  const lifetime = useRef<AbortController | null>(null);
  const active = useRef(false);
  const terminalReceipts = useRef(new Set<string>());
  const [balance, setBalance] = useState<Balance | null>(null);
  const [links, setLinks] = useState<LinkRecord[] | null>(null);
  const [receipts, setReceipts] = useState<Recovery[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [supportsLock, setSupportsLock] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [recipient, setRecipient] = useState("");
  const [quantity, setQuantity] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorScope, setErrorScope] = useState<ErrorScope>("balance");
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const linked = links?.some(link => link.walletAddress === account && link.chainId === `solana:${runtime.cluster}` && link.genesisHash === runtime.genesisHash) ?? false;
  const unresolved = receipts.some(receipt => !settled(receipt.status));
  const disabled = Boolean(busy) || !linked || !storageReady || !supportsLock || unresolved || !balance;
  const journal = () => createTransferReceiptStore(window.localStorage, { ...runtime, walletAddress: account });
  const lockName = `goosey-wallet-send:${runtime.genesisHash}:${runtime.programAddress}:${account}`;
  function unchanged(signal: AbortSignal) {
    signal.throwIfAborted();
    const current = wallet.getSnapshot();
    if (current.generation !== snapshot.generation || current.account?.address !== account || current.status !== "connected") throw new Error("Wallet changed. Select an account and prepare again.");
  }
  function observe(receipt: Receipt, status: TransactionStatus) {
    if (settled(status)) terminalReceipts.current.add(receipt.signature);
    setReceipts(previous => [...previous.filter(item => item.signature !== receipt.signature), { ...receipt, status }]);
  }
  async function verifyNetwork(signal: AbortSignal) {
    const rpc = createSolanaRpc(runtime.rpcUrl);
    if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw new Error("RPC network mismatch. Transactions are blocked.");
    return rpc;
  }
  function showError(scope: ErrorScope) {
    return error && errorScope === scope ? <p className={styles.error} role="alert">{error}</p> : null;
  }
  async function run(label: string, operation: (signal: AbortSignal) => Promise<void>, scope: ErrorScope = "balance") {
    if (active.current || !lifetime.current) return;
    active.current = true; setBusy(label); setError(null); setErrorScope(scope); setMessage(null);
    const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(120_000)]);
    try { unchanged(signal); await operation(signal); }
    catch (reason) { if (!lifetime.current.signal.aborted) setError(errorMessage(reason)); }
    finally { active.current = false; if (!lifetime.current.signal.aborted) setBusy(null); }
  }
  async function readLinks(signal: AbortSignal) {
    const body = await json<{ items: LinkRecord[] }>("/api/solana/wallet", { signal });
    if (!Array.isArray(body.items)) throw new Error("Linked wallets could not be read.");
    return body.items;
  }
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    async function load() {
      terminalReceipts.current.clear();
      setStorageReady(false);
      try {
        const [observedBalance, linkedWallets] = await Promise.all([
          readGooseyWalletBalance({ runtime, wallet: address(account), signal }),
          json<{ items: LinkRecord[] }>("/api/solana/wallet", { signal }),
        ]);
        signal.throwIfAborted();
        if (!Array.isArray(linkedWallets.items)) throw new Error("Linked wallets could not be read.");
        setBalance(observedBalance); setLinks(linkedWallets.items); setSupportsLock(Boolean(navigator.locks));
        const store = createTransferReceiptStore(window.localStorage, { ...runtime, walletAddress: account });
        const saved = await store.list(); signal.throwIfAborted();
        setReceipts(saved.receipts.map(receipt => ({ ...receipt, status: "unknown" })));
        setStorageReady(saved.unreadableKeys.length === 0);
        if (saved.unreadableKeys.length) throw new Error("A saved transaction receipt cannot be read. Recover it before sending another transaction.");
        if (!saved.receipts.length) return;
        const rpc = createSolanaRpc(runtime.rpcUrl);
        if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw new Error("RPC network mismatch. Recovery is blocked.");
        await Promise.all(saved.receipts.map(async receipt => {
          const result = await trackTransactionStatus(rpc, { ...receipt, signal, onObservation: value => { if (!controller.signal.aborted) observe(receipt, value.status); } });
          if (!controller.signal.aborted) observe(receipt, result.status);
        }));
        // A receipt can finalize after the initial balance snapshot on reload.
        // Read the finalized wallet again so recovery updates balances as well.
        const reconciledBalance = await readGooseyWalletBalance({ runtime, wallet: address(account), signal });
        signal.throwIfAborted();
        setBalance(reconciledBalance);
      } catch (reason) { if (!controller.signal.aborted) { setErrorScope("balance"); setError(errorMessage(reason)); } }
    }
    void load();
    const onStorage = (event: StorageEvent) => {
      const prefix = `goosey:transfer:v1:${runtime.cluster}:${runtime.genesisHash}:${runtime.programAddress}:${account}:`;
      if (event.key === null || event.key.startsWith(prefix)) { setReview(null); setStorageReady(false); setReload(value => value + 1); }
    };
    window.addEventListener("storage", onStorage);
    return () => { controller.abort(); window.removeEventListener("storage", onStorage); };
  }, [account, runtime, reload]);

  async function link(form: HTMLFormElement) {
    const password = String(new FormData(form).get("password") ?? "");
    form.reset();
    await run("Approve the account-link message in your wallet…", async signal => {
      await enabledRuntime(signal, runtime); unchanged(signal);
      const issued = await json<{ id: string; challenge: WalletChallenge }>("/api/solana/wallet/challenge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletAddress: account, password }), signal,
      });
      unchanged(signal);
      const signed = await wallet.signChallenge(issued.challenge, signal); unchanged(signal);
      await json("/api/solana/wallet/verify", { method: "POST", headers: { "Content-Type": "application/json" }, signal,
        body: JSON.stringify({ challengeId: issued.id, challenge: issued.challenge, signedMessageBase64: signed.signedMessageBase64, signatureBase64: signed.signatureBase64 }) });
      unchanged(signal); setLinks(await readLinks(signal)); setMessage("Wallet ownership verified and linked to your Goosey account.");
    }, "link");
  }
  async function checkReceipts() {
    const saved = await journal().list();
    if (saved.unreadableKeys.length || saved.receipts.some(receipt => !terminalReceipts.current.has(receipt.signature))) {
      setReview(null); setStorageReady(false); setReload(value => value + 1);
      throw new Error("A transaction needs reconciliation before another can be signed. Check its saved status.");
    }
  }
  async function prepare(kind: "claim" | "send") {
    if (disabled) return;
    await run("Preparing a transaction for review…", async signal => {
      setReview(null); await enabledRuntime(signal, runtime); unchanged(signal); await checkReceipts();
      const currentLinks = await readLinks(signal);
      if (!currentLinks.some(link => link.walletAddress === account && link.chainId === `solana:${runtime.cluster}` && link.genesisHash === runtime.genesisHash)) throw new Error("Link this wallet before continuing.");
      const freshBalance = await readGooseyWalletBalance({ runtime, wallet: address(account), signal });
      if (kind === "send" && (freshBalance.featherAccountStatus === "absent" || freshBalance.featherAmount === 0n)) throw new Error("This wallet has no feathers to send.");
      const signer = wallet.getSigner();
      if (kind === "claim") {
        const plan = await buildClaimFeathersInstructions({ programAddress: runtime.programAddress, wallet: signer });
        const claimRpc = await verifyNetwork(signal);
        const enrollment = await claimRpc.getAccountInfo(plan.enrollment, { commitment: "finalized", encoding: "base64" }).send({ abortSignal: signal });
        if (enrollment.value === null) throw new Error("No grant is available for this wallet yet.");
      }
      const transaction = kind === "claim" ? await prepareFeatherClaim({ runtime, wallet: signer, signal })
        : await prepareFeatherTransfer({ runtime, sender: signer, recipient: address(recipient.trim()), displayAmount: quantity.trim(), signal });
      const rpc = await verifyNetwork(signal);
      const wireMessage = getBase64Decoder().decode(compileTransaction(transaction.message).messageBytes) as TransactionMessageBytesBase64;
      const destination = "destination" in transaction ? transaction.destination : transaction.walletTokens;
      const [feeResponse, tokenAccount, rent] = await Promise.all([
        rpc.getFeeForMessage(wireMessage, { commitment: "confirmed" }).send({ abortSignal: signal }),
        rpc.getAccountInfo(destination, { commitment: "finalized", encoding: "base64" }).send({ abortSignal: signal }),
        rpc.getMinimumBalanceForRentExemption(165n, { commitment: "finalized" }).send({ abortSignal: signal }),
      ]);
      if (feeResponse.value === null) throw new Error("The transaction expired during review preparation. Prepare it again.");
      const deposit = tokenAccount.value === null ? rent : 0n;
      if (!freshBalance.ordinaryFeePayerAccount || freshBalance.solLamports < feeResponse.value + deposit) throw new Error("This wallet needs enough localnet/devnet SOL to pay the network fee and account deposit.");
      unchanged(signal); setBalance(freshBalance);
      setReview({ kind, transaction, fee: feeResponse.value, rent: deposit } as Review);
    }, kind);
  }
  async function approve() {
    if (!review || disabled) return;
    const chosen = review;
    await run("Waiting for wallet approval…", async signal => {
      if (!navigator.locks) throw new Error("This browser cannot safely coordinate wallet submissions across tabs.");
      await navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("Another tab is using this wallet. Finish that request before continuing.");
        await enabledRuntime(signal, runtime); unchanged(signal); await checkReceipts();
        const currentLinks = await readLinks(signal);
        if (!currentLinks.some(link => link.walletAddress === account && link.chainId === `solana:${runtime.cluster}` && link.genesisHash === runtime.genesisHash)) throw new Error("The selected wallet is no longer linked.");
        const rpc = await verifyNetwork(signal);
        const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send({ abortSignal: signal });
        if (height > chosen.transaction.lifetime.lastValidBlockHeight) { setReview(null); throw new Error("Review expired. Prepare again before approving."); }
        const signed = await wallet.signTransaction(chosen.transaction, signal); unchanged(signal);
        // Always discard this review once signing succeeds; uncertainty must lead
        // to recovery of this signature, never another automatic signature.
        setReview(null);
        await enabledRuntime(signal, runtime); unchanged(signal);
        setBusy("Submitting signed transaction…");
        const result = await submitSignedWalletTransaction({ runtime, prepared: chosen.transaction, signed, signal,
          onPrepared: async receipt => { unchanged(signal); await journal().persist(receipt); observe(receipt, "unknown"); unchanged(signal); } });
        observe(result, result.status); setBusy("Checking transaction finalization…");
        const trackingRpc = await verifyNetwork(signal);
        const final = await trackTransactionStatus(trackingRpc, { ...result, signal, onObservation: value => observe(result, value.status) });
        observe(result, final.status);
        setMessage(final.status === "finalized" ? "Transaction finalized. Refreshing the on-chain balance." : final.status === "failed" ? "The transaction failed on-chain. Network fees may still apply." : "The result is not final. Check this signature before starting another transaction.");
        const observed = await readGooseyWalletBalance({ runtime, wallet: address(account), signal }); unchanged(signal); setBalance(observed);
      });
    }, "review");
  }
  return <>
    <section className={styles.panel}>
      <div className={styles.heading}><h2>Wallet balance</h2><button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => { setReview(null); setError(null); setStorageReady(false); setReload(value => value + 1); }}><RefreshCw aria-hidden="true" /> Refresh</button></div>
      <code className={styles.address}>{account}</code>
      {balance ? <><div className={styles.balances}><div><span>Wallet feathers</span><strong title={`${amount(balance.featherAmount)} feathers`}>{((balance.featherAmount + 500n) / 1000n).toLocaleString("en-CA")}</strong></div><div><span>SOL for fees</span><strong>{amount(balance.solLamports, 9)}</strong></div></div><p>Finalized at slot {balance.observedSlot.toString()}. {balance.featherAccountStatus === "absent" ? "No feather token account exists yet." : ""}</p><details><summary>Deployment details</summary><dl className={styles.facts}><div><dt>Mint</dt><dd>{balance.mint}</dd></div><div><dt>Program</dt><dd>{runtime.programAddress}</dd></div><div><dt>Network identity</dt><dd>{runtime.genesisHash}</dd></div></dl></details></> : error ? <p>Balance could not be loaded. Refresh to retry.</p> : <p role="status">Reading verified on-chain balances…</p>}
      {showError("balance")}
      {message && <p role="status">{message}</p>}
      {busy && <p className={styles.progress} role="status"><LoaderCircle className="spin" aria-hidden="true" />{busy}</p>}
    </section>
    <section className={styles.panel}>
      <h2>{linked ? "Wallet linked" : "Link your wallet"}</h2>
      {linked ? <p>Ownership is verified. Linking does not issue feathers or approve transactions.</p> : <form className={styles.form} onSubmit={event => { event.preventDefault(); void link(event.currentTarget); }}>
        <p>Confirm your Goosey password, then sign an ownership message in your wallet. No transaction is sent.</p>
        {links?.length ? <p>Previously linked wallet: <code className={styles.address}>{links[0].walletAddress}</code>.</p> : null}
        <label htmlFor={`${id}-password`}>Current Goosey password</label><input id={`${id}-password`} name="password" type="password" autoComplete="current-password" required disabled={Boolean(busy)} />
        <button className="button button-primary" disabled={Boolean(busy) || links === null}>Verify and link wallet</button>
      </form>}
      {showError("link")}
    </section>
    <section className={styles.panel}>
      <h2>Claim authorized feathers</h2><p>Check for an existing grant, then review and approve it. Connecting never issues feathers. SOL is needed for fees.</p>
      <button className="button button-secondary" type="button" disabled={disabled || Boolean(review)} onClick={() => void prepare("claim")}>Check and review claim</button>
      {showError("claim")}
    </section>
    <section className={styles.panel}>
      <h2>Send feathers</h2><form className={styles.form} onSubmit={event => { event.preventDefault(); void prepare("send"); }}>
        <label htmlFor={`${id}-recipient`}>Recipient wallet address</label><input id={`${id}-recipient`} value={recipient} autoComplete="off" spellCheck={false} disabled={Boolean(busy) || Boolean(review)} onChange={event => setRecipient(event.target.value)} required />
        <label htmlFor={`${id}-quantity`}>Feathers</label><input id={`${id}-quantity`} value={quantity} inputMode="decimal" autoComplete="off" placeholder="Up to 3 decimal places" disabled={Boolean(busy) || Boolean(review)} onChange={event => setQuantity(event.target.value)} required />
        <button className="button button-secondary" disabled={disabled || Boolean(review)}>Review send</button>
      </form>
      {showError("send")}
      {!linked && <p>Link the selected wallet to enable claims and sends.</p>}
      {linked && !supportsLock && <p>Claims and sends need a secure browser with Web Locks support.</p>}
      {unresolved && <p className={styles.notice}>Check your saved transaction before sending again. Unknown or expired status may still mean it executed.</p>}
    </section>
    {!review && errorScope === "review" && error && <section className={styles.panel} aria-label="Transaction result">{showError("review")}</section>}
    {review && <section className={`${styles.panel} ${styles.review}`} aria-labelledby={`${id}-review`}>
      <h2 id={`${id}-review`} ref={reviewHeading} tabIndex={-1}>Review {review.kind === "claim" ? "claim" : "send"}</h2>
      <dl className={styles.facts}><div><dt>Feathers</dt><dd>{amount(review.transaction.amount)}</dd></div><div><dt>From / fee payer</dt><dd>{account}</dd></div><div><dt>Recipient</dt><dd>{review.kind === "send" ? review.transaction.recipient : account}</dd></div><div><dt>Network</dt><dd>{runtime.cluster}</dd></div><div><dt>Mint</dt><dd>{review.transaction.mint}</dd></div><div><dt>Network fee estimate</dt><dd>{amount(review.fee, 9)} SOL</dd></div><div><dt>Token account deposit estimate</dt><dd>{amount(review.rent, 9)} SOL</dd></div>{review.kind === "claim" && <div><dt>Grant expires</dt><dd>{new Date(Number(review.transaction.expiresAt) * 1000).toLocaleString()}</dd></div>}</dl>
      {showError("review")}
      <p>Approve this exact transaction in your wallet. Estimates may change before execution.</p>
      <div className={styles.actions}><button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => setReview(null)}>Cancel review</button><button type="button" className="button button-primary" disabled={disabled} onClick={() => void approve()}>Approve and {review.kind === "claim" ? "claim" : "send"}</button></div>
    </section>}
    {receipts.length > 0 && <section className={styles.panel} aria-label="Saved transaction receipts"><h2>Saved transactions</h2><p>These receipts are kept in this browser. Checking status never resends a transaction.</p><ul className={styles.receipts}>{receipts.map(receipt => <li key={receipt.signature}><strong>{receipt.status === "expired" ? "Expired · historical outcome unknown" : receipt.status === "failed" ? "Failed on-chain" : receipt.status.charAt(0).toUpperCase() + receipt.status.slice(1)}</strong><code>{receipt.signature}</code></li>)}</ul><button className="button button-secondary" type="button" disabled={Boolean(busy)} onClick={() => { setReview(null); setError(null); setStorageReady(false); setReload(value => value + 1); }}>Check transaction status</button></section>}
  </>;
}
