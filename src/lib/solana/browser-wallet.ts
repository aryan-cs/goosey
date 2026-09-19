"use client";

import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, StandardDisconnect, StandardEvents,
  type StandardConnectFeature, type StandardDisconnectFeature, type StandardEventsFeature } from "@wallet-standard/features";
import { SolanaSignMessage, SolanaSignTransaction,
  type SolanaSignMessageFeature, type SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import { address, assertIsSignatureBytes, compileTransaction, getAddressEncoder, getBase64Decoder,
  getPublicKeyFromAddress, getTransactionDecoder, getTransactionEncoder, verifySignature,
  type Address, type Transaction, type TransactionPartialSigner } from "@solana/kit";
import type { prepareFeatherTransfer } from "./prepare-transfer";
import type { WalletChallenge, WalletChallengeChain } from "./wallet-challenge";

type PreparedTransfer = Awaited<ReturnType<typeof prepareFeatherTransfer>>;
export type BrowserWalletSnapshot = Readonly<{
  /** Only wallets supporting the exact chain, signing features and v0 are listed. */
  wallets: readonly Wallet[];
  wallet: Wallet | null;
  accounts: readonly WalletAccount[];
  account: WalletAccount | null;
  status: "disconnected" | "connecting" | "connected" | "disposed";
  /** Change invalidates prepared UI state, challenges and pending wallet results. */
  generation: number;
}>;

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((n, i) => n === b[i]);
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function feature<T>(wallet: Wallet, name: `${string}:${string}`, method: string, versions = ["1.0.0"]): T {
  const value = wallet.features[name] as Record<string, unknown> | undefined;
  requireValue(value && versions.includes(String(value.version)) && typeof value[method] === "function", `Wallet lacks compatible ${name}`);
  return value as T;
}
const connectFeature = (w: Wallet) => feature<StandardConnectFeature[typeof StandardConnect]>(w, StandardConnect, "connect");
const eventsFeature = (w: Wallet) => feature<StandardEventsFeature[typeof StandardEvents]>(w, StandardEvents, "on");
const messageFeature = (w: Wallet) => feature<SolanaSignMessageFeature[typeof SolanaSignMessage]>(w, SolanaSignMessage, "signMessage", ["1.0.0", "1.1.0"]);
const transactionFeature = (w: Wallet) => feature<SolanaSignTransactionFeature[typeof SolanaSignTransaction]>(w, SolanaSignTransaction, "signTransaction");

/** Create inside a browser effect, not during SSR. No discovery at module load.
 * Flow: subscribe -> connect(wallet) -> selectAccount(address) -> getSigner()
 * for prepareFeatherTransfer -> explicit signTransaction(prepared) -> caller's
 * explicit submitSignedFeatherTransfer. The latter independently verifies exact
 * message/signatures and pins RPC genesis. This adapter never sends or uses RPC.
 * signChallenge signs the server's exact SIWS bytes; server nonce consumption
 * remains mandatory. dispose() removes OUR subscriptions, not the app registry's
 * shared global Wallet Standard discovery listener, and never prompts a wallet.
 *
 * Primary interfaces: https://wallet-standard.github.io/wallet-standard/
 * https://github.com/anza-xyz/wallet-standard/tree/master/packages/core/features
 */
export function createBrowserWallet(input: { chain: WalletChallengeChain; genesisHash: string }) {
  requireValue(typeof window !== "undefined", "Browser wallet must be created in the browser, not during SSR");
  const { chain, genesisHash } = input;
  requireValue(chain === "solana:localnet" || chain === "solana:devnet", "Only exact localnet/devnet wallet chains are supported");
  requireValue(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesisHash), "An explicit genesis pin is required");
  const devnet = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  requireValue(!["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"].includes(genesisHash)
    && (chain === "solana:devnet" ? genesisHash === devnet : genesisHash !== devnet), "Genesis does not match the permitted wallet chain");
  const origin = window.location.origin;
  requireValue(["http:", "https:"].includes(window.location.protocol), "Wallet challenges require an HTTP(S) origin");
  const registry = getWallets();
  const subscribers = new Set<() => void>();
  const signerGenerations = new WeakMap<object, number>();
  let wallet: Wallet | null = null;
  let selected: { address: Address; publicKey: Uint8Array } | null = null;
  let status: BrowserWalletSnapshot["status"] = "disconnected";
  let generation = 0;
  let connectionAttempt = 0;
  let invalidation = new AbortController();
  let offWallet: (() => void) | undefined;
  let busy = false;
  let snapshot: BrowserWalletSnapshot;

  function alive() { requireValue(status !== "disposed", "Browser wallet has been disposed"); }
  function compatible(candidate: Wallet) {
    try {
      requireValue(candidate.version === "1.0.0" && Array.isArray(candidate.chains) && candidate.chains.includes(chain), "Wallet does not support the exact chain");
      connectFeature(candidate); eventsFeature(candidate); messageFeature(candidate);
      const versions = transactionFeature(candidate).supportedTransactionVersions;
      requireValue(Array.isArray(versions) && versions.includes(0), "Wallet does not support v0 transactions");
      return true;
    } catch { return false; }
  }
  function usableAccount(account: WalletAccount) {
    try {
      return Array.isArray(account.chains) && Array.isArray(account.features)
        && account.chains.includes(chain) && account.features.includes(SolanaSignMessage)
        && account.features.includes(SolanaSignTransaction)
        && sameBytes(account.publicKey, getAddressEncoder().encode(address(account.address)));
    } catch { return false; }
  }
  const copyAccount = (account: WalletAccount): WalletAccount => Object.freeze({ address: account.address,
    publicKey: new Uint8Array(account.publicKey), chains: Object.freeze([...account.chains]), features: Object.freeze([...account.features]),
    label: account.label, icon: account.icon });
  function publish() {
    const accounts = wallet && status === "connected" ? wallet.accounts.filter(usableAccount).map(copyAccount) : [];
    snapshot = Object.freeze({ wallets: Object.freeze(registry.get().filter(compatible)), wallet,
      accounts: Object.freeze(accounts), account: accounts.find(a => a.address === selected?.address) ?? null, status, generation });
    // A UI subscriber must not break invalidation or stop other listeners.
    for (const subscriber of subscribers) { try { subscriber(); } catch { /* UI owns its error reporting */ } }
  }
  function invalidate() {
    generation++;
    invalidation.abort(new Error("Wallet state changed; discard pending request and prepare again"));
    invalidation = new AbortController();
    selected = null;
  }
  function detach() { const off = offWallet; offWallet = undefined; try { off?.(); } catch { /* Still invalidate state and remove registry subscriptions. */ } }
  function clear() {
    connectionAttempt++;
    invalidate();
    detach();
    wallet = null;
    status = "disconnected";
  }
  function current() {
    alive();
    requireValue(status === "connected" && wallet && selected, "Explicitly connect and select a wallet account first");
    requireValue(registry.get().includes(wallet) && compatible(wallet), "Wallet registration or network capability changed");
    const matches = wallet.accounts.filter(a => a.address === selected!.address);
    requireValue(matches.length === 1 && usableAccount(matches[0]) && sameBytes(matches[0].publicKey, selected.publicKey), "Selected account or its exact network capabilities changed");
    const message = messageFeature(wallet), transaction = transactionFeature(wallet);
    return { wallet, account: matches[0], address: selected.address, generation,
      signal: invalidation.signal, message, transaction,
      messageMethod: message.signMessage, transactionMethod: transaction.signTransaction };
  }
  type Selection = ReturnType<typeof current>;
  function unchanged(selection: Selection, signal?: AbortSignal) {
    signal?.throwIfAborted();
    selection.signal.throwIfAborted();
    const now = current();
    requireValue(now.generation === selection.generation && now.wallet === selection.wallet && now.address === selection.address
      && now.messageMethod === selection.messageMethod && now.transactionMethod === selection.transactionMethod,
    "Wallet state changed; discard pending request and prepare again");
  }
  async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
    } finally { signal.removeEventListener("abort", onAbort); }
  }
  async function request<T>(selection: Selection, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>) {
    unchanged(selection, signal);
    requireValue(!busy, "A wallet signing request is already pending");
    busy = true;
    const combined = signal ? AbortSignal.any([signal, selection.signal]) : selection.signal;
    try {
      const result = await wait(action(combined), combined);
      unchanged(selection, signal);
      return result;
    } finally { busy = false; }
  }
  async function signWire(transaction: Transaction, selection: Selection, signal?: AbortSignal): Promise<Transaction> {
    // Copy before handing any buffers to wallet code. Only this single-account,
    // v0 transfer signer is supported; do not silently accept multisig rewrites.
    const expected = new Uint8Array(transaction.messageBytes);
    requireValue(expected[0] === 0x80, "Only prepared v0 transactions are supported");
    requireValue(Object.keys(transaction.signatures).length === 1 && selection.address in transaction.signatures, "Unexpected transaction signer set");
    const wire = new Uint8Array(getTransactionEncoder().encode(transaction));
    requireValue(wire.length <= 1232, "Transaction exceeds the Solana wire size limit");
    return request(selection, signal, async () => {
      const outputs = await selection.transaction.signTransaction({ account: selection.account, chain, transaction: wire });
      unchanged(selection, signal);
      requireValue(outputs.length === 1 && outputs[0].signedTransaction instanceof Uint8Array, "Wallet returned an invalid transaction result count or encoding");
      requireValue(outputs[0].signedTransaction.length <= 1232, "Returned transaction exceeds the Solana wire size limit");
      const returnedBytes = new Uint8Array(outputs[0].signedTransaction);
      const signed = getTransactionDecoder().decode(returnedBytes);
      requireValue(sameBytes(getTransactionEncoder().encode(signed), returnedBytes), "Wallet returned noncanonical transaction bytes");
      requireValue(sameBytes(signed.messageBytes, expected), "Wallet altered the prepared transaction message");
      requireValue(Object.keys(signed.signatures).length === 1 && selection.address in signed.signatures, "Unexpected returned transaction signer set");
      const signature = signed.signatures[selection.address];
      requireValue(signature, "Wallet did not sign the selected account");
      assertIsSignatureBytes(signature);
      requireValue(await verifySignature(await getPublicKeyFromAddress(selection.address), signature, expected), "Invalid selected-account transaction signature");
      return signed;
    });
  }
  const offRegister = registry.on("register", () => { if (status !== "disposed") publish(); });
  const offUnregister = registry.on("unregister", (...removed) => {
    if (status === "disposed") return;
    if (wallet && removed.includes(wallet)) clear();
    publish();
  });
  publish();

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { alive(); subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    async connect(candidate: Wallet) {
      alive();
      requireValue(registry.get().includes(candidate) && compatible(candidate), "Wallet is unregistered or lacks exact network/signing capabilities");
      clear();
      wallet = candidate;
      status = "connecting";
      const attempt = connectionAttempt;
      try {
        offWallet = eventsFeature(candidate).on("change", properties => {
          if (wallet !== candidate || attempt !== connectionAttempt || status === "disposed") return;
          invalidate();
          // A replaced events API cannot safely keep the old subscription. Require
          // explicit reconnect rather than signing with a stale feature object.
          if (properties.features !== undefined || !compatible(candidate)) clear();
          publish();
        });
        requireValue(typeof offWallet === "function", "Wallet events API must return an unsubscribe function");
        publish();
        requireValue(attempt === connectionAttempt && wallet === candidate, "Wallet connection was superseded");
        await connectFeature(candidate).connect(); // Never silently auto-connect.
        requireValue(attempt === connectionAttempt && wallet === candidate, "Wallet connection was superseded");
        requireValue(compatible(candidate), "Wallet capability changed during connection");
        status = "connected";
        publish();
        return snapshot; // No implicit first-account selection.
      } catch (error) {
        if (attempt === connectionAttempt && wallet === candidate) { clear(); publish(); }
        throw error;
      }
    },
    selectAccount(walletAddress: string) {
      alive();
      requireValue(status === "connected" && wallet, "Connect a wallet before selecting an account");
      const matches = wallet.accounts.filter(a => a.address === walletAddress);
      requireValue(matches.length === 1 && usableAccount(matches[0]) && compatible(wallet), "Account lacks exact network/signing capabilities or is ambiguous");
      invalidate();
      selected = { address: address(walletAddress), publicKey: new Uint8Array(matches[0].publicKey) };
      publish();
      return snapshot;
    },
    async disconnect() {
      alive();
      const previous = wallet;
      clear(); publish(); // Invalidate immediately, even if the wallet rejects.
      if (previous?.features[StandardDisconnect]) {
        await feature<StandardDisconnectFeature[typeof StandardDisconnect]>(previous, StandardDisconnect, "disconnect").disconnect();
      }
    },
    getSigner(): TransactionPartialSigner {
      const selection = current();
      const signer: TransactionPartialSigner = Object.freeze({ address: selection.address, async signTransactions(transactions, config) {
        requireValue(transactions.length === 1, "Explicitly request one wallet transaction at a time");
        const signed = await signWire(transactions[0], selection, config?.abortSignal);
        const signature = signed.signatures[selection.address];
        requireValue(signature, "Missing selected-account signature");
        return [{ [selection.address]: signature }];
      } });
      signerGenerations.set(signer, selection.generation);
      return signer;
    },
    async signTransaction(prepared: PreparedTransfer, signal?: AbortSignal) {
      const selection = current();
      requireValue(signerGenerations.get(prepared.message.feePayer) === selection.generation, "Prepare again with this selection's getSigner(); previous wallet generation is stale");
      requireValue(prepared.sender === selection.address && `solana:${prepared.cluster}` === chain
        && prepared.genesisHash === genesisHash, "Prepared transfer account/network does not match the selected wallet");
      return signWire(compileTransaction(prepared.message), selection, signal);
    },
    async signChallenge(challenge: WalletChallenge, signal?: AbortSignal) {
      const selection = current();
      const issued = Date.parse(challenge.issuedAt), expires = Date.parse(challenge.expirationTime);
      const statement = "Link this Solana wallet to your Goosey account. This does not authorize a transaction.";
      requireValue(window.location.origin === origin && challenge.uri === origin && challenge.domain === new URL(origin).host
        && challenge.chainId === chain && challenge.genesisHash === genesisHash && challenge.walletAddress === selection.address,
      "Challenge origin, account or network does not match the selected wallet");
      requireValue(challenge.version === "1" && challenge.statement === statement && /^[0-9a-f]{64}$/.test(challenge.nonce)
        && challenge.resources.length === 1 && challenge.resources[0] === `urn:solana:genesis:${genesisHash}`
        && Number.isFinite(issued) && Number.isFinite(expires) && new Date(issued).toISOString() === challenge.issuedAt
        && new Date(expires).toISOString() === challenge.expirationTime && issued <= Date.now() && expires > Date.now()
        && expires > issued && expires - issued <= 300_000, "Invalid or expired wallet challenge");
      const canonical = [`${challenge.domain} wants you to sign in with your Solana account:`, challenge.walletAddress, "",
        statement, "", `URI: ${challenge.uri}`, "Version: 1", `Chain ID: ${chain}`, `Nonce: ${challenge.nonce}`,
        `Issued At: ${challenge.issuedAt}`, `Expiration Time: ${challenge.expirationTime}`, "Resources:", `- urn:solana:genesis:${genesisHash}`].join("\n");
      requireValue(challenge.message === canonical, "Challenge message does not match its binding fields");
      const expected = new TextEncoder().encode(canonical);
      requireValue(expected.length <= 4096, "Wallet challenge is too large");
      return request(selection, signal, async () => {
        const outputs = await selection.message.signMessage({ account: selection.account, message: new Uint8Array(expected) });
        unchanged(selection, signal);
        requireValue(outputs.length === 1, "Wallet returned an invalid message result count");
        const output = outputs[0];
        requireValue(output.signedMessage instanceof Uint8Array && output.signature instanceof Uint8Array
          && (output.signatureType === undefined || output.signatureType === "ed25519"), "Wallet returned an invalid Ed25519 result");
        const signedMessage = new Uint8Array(output.signedMessage), signature = new Uint8Array(output.signature);
        requireValue(sameBytes(signedMessage, expected), "Wallet altered the challenge bytes");
        assertIsSignatureBytes(signature);
        requireValue(await verifySignature(await getPublicKeyFromAddress(selection.address), signature, expected), "Invalid selected-account challenge signature");
        requireValue(Date.now() < expires && window.location.origin === origin, "Challenge expired or origin changed while awaiting approval");
        return Object.freeze({ walletAddress: selection.address, signedMessageBase64: getBase64Decoder().decode(signedMessage),
          signatureBase64: getBase64Decoder().decode(signature), generation: selection.generation });
      });
    },
    dispose() {
      if (status === "disposed") return;
      clear(); status = "disposed";
      offRegister(); offUnregister(); publish(); subscribers.clear();
    },
  });
}
