/** UNIT tests: mocked browser/Wallet Standard registry and RPC. Real ephemeral
 * Ed25519 signatures and Kit codecs, NOT extension/browser/local-chain proof. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { StandardEventsChangeProperties } from "@wallet-standard/features";
import type { SolanaSignMessageInput, SolanaSignMessageOutput, SolanaSignTransactionInput, SolanaSignTransactionOutput } from "@solana/wallet-standard-features";
import { address, appendTransactionMessageInstructions, blockhash, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getAddressEncoder, getBase64Encoder, getSignatureFromTransaction, getTransactionDecoder,
  getTransactionEncoder, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signBytes, signTransaction, signTransactionMessageWithSigners, type Transaction } from "@solana/kit";
import { createBrowserWallet } from "./browser-wallet";
import { createWalletChallenge, verifyWalletChallenge, type WalletChallenge } from "./wallet-challenge";
import { buildFeatherTransfer } from "./feather-transfer";
import { submitSignedFeatherTransfer } from "./submit-transfer";

const mock = vi.hoisted(() => ({ registry: vi.fn(), genesis: vi.fn(), height: vi.fn(), send: vi.fn() }));
vi.mock("@wallet-standard/app", () => ({ getWallets: mock.registry }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: mock.genesis }), getBlockHeight: () => ({ send: mock.height }),
    sendTransaction: () => ({ send: mock.send }) }),
}));
const genesisHash = "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm";
const network = { chain: "solana:localnet" as const, genesisHash };
const origin = "http://127.0.0.1:8080";
const controllers: ReturnType<typeof createBrowserWallet>[] = [];
let registered: Wallet[];
let listeners: Record<"register" | "unregister", Set<(...wallets: Wallet[]) => void>>;
function adapter() { const result = createBrowserWallet(network); controllers.push(result); return result; }
function registration(wallet: Wallet) { registered.push(wallet); listeners.register.forEach(fn => fn(wallet)); }
function unregistration(wallet: Wallet) { registered = registered.filter(w => w !== wallet); listeners.unregister.forEach(fn => fn(wallet)); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture() {
  const key = await generateKeyPairSigner(), other = await generateKeyPairSigner();
  const account: WalletAccount = { address: key.address, publicKey: getAddressEncoder().encode(key.address),
    chains: [network.chain], features: ["solana:signMessage", "solana:signTransaction"] };
  const otherAccount: WalletAccount = { ...account, address: other.address, publicKey: getAddressEncoder().encode(other.address) };
  const changes = new Set<(properties: StandardEventsChangeProperties) => void>();
  const state = { accounts: [account, otherAccount] as readonly WalletAccount[], chains: [network.chain] as Wallet["chains"] };
  const signMessage = vi.fn(async (...inputs: readonly SolanaSignMessageInput[]): Promise<readonly SolanaSignMessageOutput[]> => {
    const input = inputs[0], signer = input.account.address === key.address ? key : other;
    return [{ signedMessage: input.message, signature: await signBytes(signer.keyPair.privateKey, input.message), signatureType: "ed25519" }];
  });
  const signTx = vi.fn(async (...inputs: readonly SolanaSignTransactionInput[]): Promise<readonly SolanaSignTransactionOutput[]> => {
    const input = inputs[0], signer = input.account.address === key.address ? key : other;
    const signed = await signTransaction([signer.keyPair], getTransactionDecoder().decode(input.transaction));
    return [{ signedTransaction: new Uint8Array(getTransactionEncoder().encode(signed)) }];
  });
  const connect = vi.fn(async () => ({ accounts: state.accounts }));
  const disconnect = vi.fn(async () => {});
  const off = vi.fn();
  const features: Record<string, unknown> = {
    "standard:connect": { version: "1.0.0", connect },
    "standard:disconnect": { version: "1.0.0", disconnect },
    "standard:events": { version: "1.0.0", on: (_event: string, listener: (properties: StandardEventsChangeProperties) => void) => {
      changes.add(listener); return () => { off(); changes.delete(listener); };
    } },
    "solana:signMessage": { version: "1.1.0", signMessage },
    "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: [0], signTransaction: signTx },
  };
  const wallet: Wallet = { version: "1.0.0", name: "Unit-test wallet", icon: "data:image/png;base64,",
    get accounts() { return state.accounts; }, get chains() { return state.chains; }, features };
  function emit(properties: StandardEventsChangeProperties) {
    if (properties.accounts !== undefined) state.accounts = properties.accounts;
    if (properties.chains !== undefined) state.chains = properties.chains;
    changes.forEach(listener => listener(properties));
  }
  registration(wallet);
  const controller = adapter();
  async function select() { await controller.connect(wallet); controller.selectAccount(key.address); }
  const challenge = () => createWalletChallenge({ origin, chainId: network.chain, genesisHash, walletAddress: key.address });
  async function prepared() {
    const sender = controller.getSigner();
    const mint = address("EPXKTspQpNsYjw8khbTawjXeUJdVknL1iDrxVq7itvaw");
    const plan = await buildFeatherTransfer({ mint, sender, recipient: other.address, amount: 123n });
    const lifetime = { blockhash: blockhash(genesisHash), lastValidBlockHeight: 100n };
    const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(sender, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx), tx => appendTransactionMessageInstructions(plan.instructions, tx));
    return { ...plan, message, mint, sender: sender.address, recipient: other.address, finalizedBalance: 1000n, observedSlot: 1n,
      lifetime, cluster: "localnet" as const, genesisHash };
  }
  return { wallet, account, otherAccount, key, other, features, state, changes, signMessage, signTx, connect, disconnect, off, emit, controller, select, challenge, prepared };
}
beforeEach(() => {
  vi.resetAllMocks();
  registered = []; listeners = { register: new Set(), unregister: new Set() };
  mock.registry.mockReturnValue({ get: () => registered, on: (event: "register" | "unregister", listener: (...wallets: Wallet[]) => void) => {
    listeners[event].add(listener); return () => { listeners[event].delete(listener); };
  } });
  vi.stubGlobal("window", { location: new URL(origin) });
  mock.genesis.mockResolvedValue(genesisHash); mock.height.mockResolvedValue(50n);
});
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("browser wallet lifecycle (mocked Wallet Standard, not browser proof)", () => {
  it("rejects SSR without initializing shared discovery", () => {
    vi.stubGlobal("window", undefined);
    expect(() => adapter()).toThrow("SSR"); expect(mock.registry).not.toHaveBeenCalled();
  });
  it("does not connect, choose an account, sign or contact RPC on discovery", async () => {
    const f = await fixture();
    expect(f.controller.getSnapshot()).toMatchObject({ wallets: [f.wallet], wallet: null, account: null, status: "disconnected" });
    expect(f.connect).not.toHaveBeenCalled(); expect(f.signMessage).not.toHaveBeenCalled(); expect(f.signTx).not.toHaveBeenCalled();
    expect(mock.genesis).not.toHaveBeenCalled();
  });
  it("observes late register/unregister and detaches selected wallet", async () => {
    const c = adapter(), listener = vi.fn(); c.subscribe(listener);
    const f = await fixture(); expect(c.getSnapshot().wallets).toEqual([f.wallet]);
    await c.connect(f.wallet); c.selectAccount(f.key.address);
    unregistration(f.wallet);
    expect(c.getSnapshot()).toMatchObject({ wallet: null, account: null, status: "disconnected" });
    expect(f.off).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenCalled();
  });
  it("connects explicitly without silently selecting the first of multiple accounts", async () => {
    const f = await fixture(); await f.controller.connect(f.wallet);
    expect(f.connect).toHaveBeenCalledWith(); expect(f.controller.getSnapshot().accounts).toHaveLength(2);
    expect(() => f.controller.getSigner()).toThrow("select");
    f.controller.selectAccount(f.other.address); expect(f.controller.getSigner().address).toBe(f.other.address);
  });
  it.each(["chain", "events", "connect", "message", "transaction", "version"])("rejects incompatible wallet %s before prompting", async reason => {
    const f = await fixture();
    if (reason === "chain") f.state.chains = ["solana:devnet"];
    if (reason === "events") delete f.features["standard:events"];
    if (reason === "connect") delete f.features["standard:connect"];
    if (reason === "message") delete f.features["solana:signMessage"];
    if (reason === "transaction") delete f.features["solana:signTransaction"];
    if (reason === "version") f.features["solana:signTransaction"] = { version: "1.0.0", supportedTransactionVersions: ["legacy"], signTransaction: f.signTx };
    await expect(f.controller.connect(f.wallet)).rejects.toThrow("capabilities"); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(["chain", "feature", "key", "duplicate", "missing"])("rejects account-level %s instead of falling back to another account", async reason => {
    const f = await fixture(); await f.controller.connect(f.wallet);
    if (reason === "chain") f.state.accounts = [{ ...f.account, chains: ["solana:devnet"] }];
    if (reason === "feature") f.state.accounts = [{ ...f.account, features: ["solana:signMessage"] }];
    if (reason === "key") f.state.accounts = [{ ...f.account, publicKey: f.otherAccount.publicKey }];
    if (reason === "duplicate") f.state.accounts = [f.account, f.account];
    if (reason === "missing") f.state.accounts = [f.otherAccount];
    expect(() => f.controller.selectAccount(f.key.address)).toThrow("capabilities");
  });
  it("rejects an unregistered object even if its display name matches", async () => {
    const f = await fixture(); await expect(f.controller.connect({ ...f.wallet })).rejects.toThrow("unregistered");
  });
  it("rejects unsupported cluster/genesis combinations", () => {
    for (const input of [{ chain: "solana:mainnet", genesisHash }, { ...network, genesisHash: "" },
      { ...network, genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }, { chain: "solana:devnet", genesisHash }]) {
      expect(() => createBrowserWallet(input as typeof network)).toThrow();
    }
  });
  it("supports explicit devnet without treating it as localnet capability", async () => {
    const f = await fixture();
    f.state.chains = ["solana:devnet"];
    f.state.accounts = [{ ...f.account, chains: ["solana:devnet"] }];
    const dev = createBrowserWallet({ chain: "solana:devnet", genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });
    controllers.push(dev);
    await dev.connect(f.wallet); dev.selectAccount(f.key.address);
    expect(dev.getSigner().address).toBe(f.key.address);
    await expect(f.controller.connect(f.wallet)).rejects.toThrow("capabilities");
  });
  it("clears state when attaching the wallet events listener fails", async () => {
    const f = await fixture(); f.features["standard:events"] = { version: "1.0.0", on: () => { throw new Error("events unavailable"); } };
    await expect(f.controller.connect(f.wallet)).rejects.toThrow("events unavailable");
    expect(f.controller.getSnapshot().status).toBe("disconnected"); expect(f.connect).not.toHaveBeenCalled();
  });
  it("copies class-getter accounts and isolates snapshot byte mutation from selection", async () => {
    const f = await fixture();
    class GetterAccount implements WalletAccount {
      get address() { return f.account.address; }
      get publicKey() { return f.account.publicKey; }
      get features() { return f.account.features; }
      get chains() { return f.account.chains; }
    }
    f.state.accounts = [new GetterAccount()]; await f.select();
    const snapshot = f.controller.getSnapshot();
    expect(snapshot.account?.address).toBe(f.key.address);
    (snapshot.account!.publicKey as Uint8Array).fill(0);
    expect(f.controller.getSigner().address).toBe(f.key.address);
    await expect(f.controller.signChallenge(f.challenge())).resolves.toMatchObject({ walletAddress: f.key.address });
  });
  it("handles connect rejection and releases its event subscription", async () => {
    const f = await fixture(); f.connect.mockRejectedValue(new Error("User rejected connect"));
    await expect(f.controller.connect(f.wallet)).rejects.toThrow("User rejected");
    expect(f.controller.getSnapshot().status).toBe("disconnected"); expect(f.changes.size).toBe(0);
  });
  it("handles ordinary accounts events emitted during connect, without selecting automatically", async () => {
    const f = await fixture(); f.connect.mockImplementation(async () => { f.emit({ accounts: [f.account] }); return { accounts: [f.account] }; });
    await f.controller.connect(f.wallet); expect(f.controller.getSnapshot()).toMatchObject({ status: "connected", account: null });
  });
  it("ignores a superseded connection's late result", async () => {
    const f = await fixture(), g = await fixture(), pending = deferred<{ accounts: readonly WalletAccount[] }>();
    f.connect.mockReturnValue(pending.promise);
    const first = f.controller.connect(f.wallet);
    await f.controller.connect(g.wallet); pending.resolve({ accounts: [f.account] });
    await expect(first).rejects.toThrow("superseded"); expect(f.controller.getSnapshot().wallet).toBe(g.wallet);
  });
  it.each([false, true])("clears state even when disconnect rejects=%s", async rejects => {
    const f = await fixture(); await f.select();
    if (rejects) f.disconnect.mockRejectedValue(new Error("disconnect rejected"));
    const result = f.controller.disconnect(); expect(f.controller.getSnapshot().account).toBeNull();
    if (rejects) await expect(result).rejects.toThrow("rejected"); else await result;
    expect(f.changes.size).toBe(0);
  });
  it("supports local disconnect when the optional feature is missing", async () => {
    const f = await fixture(); delete f.features["standard:disconnect"]; await f.select(); await f.controller.disconnect();
    expect(f.controller.getSnapshot().status).toBe("disconnected");
  });
  it("disposes idempotently without prompting and removes all owned subscriptions", async () => {
    const f = await fixture(); await f.select(); const onChange = vi.fn(), unsubscribe = f.controller.subscribe(onChange);
    unsubscribe(); f.controller.dispose(); f.controller.dispose();
    expect(f.changes.size).toBe(0); expect(listeners.register.size).toBe(0); expect(listeners.unregister.size).toBe(0);
    expect(f.disconnect).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
    expect(() => f.controller.getSigner()).toThrow("disposed");
  });
});

describe("exact SIWS challenge signing (real Ed25519, mocked wallet)", () => {
  it("signs exact server challenge bytes and passes the shipping server verifier", async () => {
    const f = await fixture(); await f.select(); const challenge = f.challenge();
    const result = await f.controller.signChallenge(challenge);
    expect(verifyWalletChallenge({ challenge, context: { origin, chainId: network.chain, genesisHash, walletAddress: f.key.address }, ...result })).toMatchObject({ verified: true, nonceConsumptionRequired: true });
    expect(getBase64Encoder().encode(result.signedMessageBase64)).toEqual(new TextEncoder().encode(challenge.message));
    expect(mock.send).not.toHaveBeenCalled();
  });
  it.each(["walletAddress", "chainId", "genesisHash", "uri", "domain", "message", "nonce", "resources", "expired", "future"])("rejects challenge %s mismatch before prompting", async field => {
    const f = await fixture(); await f.select(); const challenge = f.challenge();
    const patch: Record<string, unknown> = { [field]: "wrong" };
    if (field === "resources") patch.resources = [];
    if (field === "expired") patch.expirationTime = new Date(Date.now() - 1).toISOString();
    if (field === "future") patch.issuedAt = new Date(Date.now() + 1000).toISOString();
    await expect(f.controller.signChallenge({ ...challenge, ...patch } as WalletChallenge)).rejects.toThrow();
    expect(f.signMessage).not.toHaveBeenCalled();
  });
  it.each(["changed bytes", "wrong key", "short signature", "wrong type", "no result", "extra result"])("rejects %s", async fault => {
    const f = await fixture(); await f.select();
    f.signMessage.mockImplementation(async (...inputs: readonly SolanaSignMessageInput[]) => {
      const input = inputs[0];
      if (fault === "no result") return [];
      const signedMessage = fault === "changed bytes" ? new Uint8Array([1]) : input.message;
      const signature = fault === "short signature" ? new Uint8Array(63) : await signBytes((fault === "wrong key" ? f.other : f.key).keyPair.privateKey, signedMessage);
      const output = { signedMessage, signature, signatureType: fault === "wrong type" ? "secp256k1" : "ed25519" } as SolanaSignMessageOutput;
      return fault === "extra result" ? [output, output] : [output];
    });
    await expect(f.controller.signChallenge(f.challenge())).rejects.toThrow();
  });
  it("propagates wallet rejection without retry or automatic alternative signing", async () => {
    const f = await fixture(); await f.select(); f.signMessage.mockRejectedValue(new Error("User declined"));
    await expect(f.controller.signChallenge(f.challenge())).rejects.toThrow("User declined"); expect(f.signMessage).toHaveBeenCalledTimes(1);
  });
  it("accepts implicit Ed25519 type and rejects a wallet mutating its input buffer", async () => {
    const f = await fixture(); await f.select();
    f.signMessage.mockImplementation(async (...inputs: readonly SolanaSignMessageInput[]) => {
      const message = inputs[0].message;
      return [{ signedMessage: message, signature: await signBytes(f.key.keyPair.privateKey, message) }];
    });
    await expect(f.controller.signChallenge(f.challenge())).resolves.toMatchObject({ walletAddress: f.key.address });
    f.signMessage.mockImplementation(async (...inputs: readonly SolanaSignMessageInput[]) => {
      const message = inputs[0].message; message[0] ^= 1;
      return [{ signedMessage: message, signature: await signBytes(f.key.keyPair.privateKey, message) }];
    });
    await expect(f.controller.signChallenge(f.challenge())).rejects.toThrow("altered");
  });
  it("detects signing-method replacement even without the required wallet event", async () => {
    const f = await fixture(); await f.select(); const pending = deferred<readonly SolanaSignMessageOutput[]>();
    f.signMessage.mockReturnValue(pending.promise); const challenge = f.challenge();
    const signing = f.controller.signChallenge(challenge);
    const rejection = expect(signing).rejects.toThrow("changed");
    (f.features["solana:signMessage"] as { signMessage: unknown }).signMessage = vi.fn();
    const message = new TextEncoder().encode(challenge.message);
    pending.resolve([{ signedMessage: message, signature: await signBytes(f.key.keyPair.privateKey, message) }]);
    await rejection;
  });
  it.each(["accounts", "chains", "features", "unregister", "disconnect", "dispose", "selection"])("invalidates pending challenge on %s immediately, ignoring its eventual signature", async change => {
    const f = await fixture(); await f.select(); const pending = deferred<readonly SolanaSignMessageOutput[]>();
    f.signMessage.mockReturnValue(pending.promise); const result = f.controller.signChallenge(f.challenge());
    const rejection = expect(result).rejects.toThrow("changed");
    if (change === "accounts") f.emit({ accounts: [f.otherAccount] });
    if (change === "chains") f.emit({ chains: ["solana:devnet"] });
    if (change === "features") f.emit({ features: f.wallet.features });
    if (change === "unregister") unregistration(f.wallet);
    if (change === "disconnect") await f.controller.disconnect();
    if (change === "dispose") f.controller.dispose();
    if (change === "selection") f.controller.selectAccount(f.other.address);
    await rejection; pending.resolve([]);
  });
  it("rejects concurrent prompts and allows explicit cancellation without sending", async () => {
    const f = await fixture(); await f.select(); const pending = deferred<readonly SolanaSignMessageOutput[]>(), cancel = new AbortController();
    f.signMessage.mockReturnValue(pending.promise);
    const first = f.controller.signChallenge(f.challenge(), cancel.signal);
    const rejection = expect(first).rejects.toThrow();
    await expect(f.controller.signChallenge(f.challenge())).rejects.toThrow("already pending");
    cancel.abort(); await rejection; pending.resolve([]); expect(f.signMessage).toHaveBeenCalledTimes(1);
  });
  it("rejects approval after challenge expiry", async () => {
    const f = await fixture(); await f.select(); const challenge = f.challenge();
    const original = f.signMessage.getMockImplementation()!;
    f.signMessage.mockImplementation(async (...args) => { const result = await original(...args); vi.spyOn(Date, "now").mockReturnValue(Date.parse(challenge.expirationTime)); return result; });
    try { await expect(f.controller.signChallenge(challenge)).rejects.toThrow("expired"); } finally { vi.restoreAllMocks(); }
  });
});

describe("Kit byte bridge (real codecs/signatures, mocked wallet and RPC)", () => {
  it("signs exact prepared v0 bytes without RPC, then independently passes the shipping submit helper", async () => {
    const f = await fixture(); await f.select(); const prepared = await f.prepared();
    expect(f.signTx).not.toHaveBeenCalled();
    const signed = await f.controller.signTransaction(prepared);
    expect(signed.messageBytes).toEqual(compileTransaction(prepared.message).messageBytes);
    expect(f.signTx.mock.calls[0][0]).toMatchObject({ account: f.account, chain: network.chain });
    expect(mock.genesis).not.toHaveBeenCalled(); expect(mock.send).not.toHaveBeenCalled();
    mock.send.mockResolvedValue(getSignatureFromTransaction(signed));
    const submission = await submitSignedFeatherTransfer({ prepared, signed, runtime: { cluster: "localnet", genesisHash,
      programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), rpcUrl: "http://127.0.0.1:18999" }, onPrepared: vi.fn() });
    expect(submission.status).toBe("submitted"); expect(mock.send).toHaveBeenCalledTimes(1);
  });
  it("works as a Kit partial signer only when explicitly asked to sign", async () => {
    const f = await fixture(); await f.select(); const prepared = await f.prepared();
    const signed = await signTransactionMessageWithSigners(prepared.message);
    expect(getSignatureFromTransaction(signed)).toBeTruthy(); expect(f.signTx).toHaveBeenCalledTimes(1);
  });
  it.each(["changed message", "wrong key", "missing signature", "extra bytes", "malformed bytes", "empty result", "extra result"])("rejects %s without RPC", async fault => {
    const f = await fixture(); await f.select(); const prepared = await f.prepared();
    f.signTx.mockImplementation(async (...inputs: readonly SolanaSignTransactionInput[]) => {
      const input = inputs[0];
      if (fault === "empty result") return [];
      if (fault === "malformed bytes") return [{ signedTransaction: new Uint8Array([255]) }];
      const transaction = getTransactionDecoder().decode(input.transaction);
      const messageBytes = new Uint8Array(transaction.messageBytes);
      if (fault === "changed message") messageBytes[messageBytes.length - 1] ^= 1;
      const signature = fault === "missing signature" ? null : await signBytes((fault === "wrong key" ? f.other : f.key).keyPair.privateKey, messageBytes);
      const signed = { messageBytes, signatures: { [f.key.address]: signature } } as unknown as Transaction;
      const wire = getTransactionEncoder().encode(signed);
      const output = { signedTransaction: new Uint8Array(fault === "extra bytes" ? [...wire, 0] : wire) };
      return fault === "extra result" ? [output, output] : [output];
    });
    await expect(f.controller.signTransaction(prepared)).rejects.toThrow(); expect(mock.send).not.toHaveBeenCalled();
  });
  it.each(["sender", "cluster", "genesisHash"])("rejects prepared %s mismatch before signing", async field => {
    const f = await fixture(); await f.select(); const prepared = await f.prepared();
    await expect(f.controller.signTransaction({ ...prepared, [field]: "wrong" })).rejects.toThrow("account/network");
    expect(f.signTx).not.toHaveBeenCalled();
  });
  it("rejects old preparation after reselecting even the same account", async () => {
    const f = await fixture(); await f.select(); const prepared = await f.prepared();
    f.controller.selectAccount(f.key.address);
    await expect(f.controller.signTransaction(prepared)).rejects.toThrow("stale");
    await expect(signTransactionMessageWithSigners(prepared.message)).rejects.toThrow("changed");
    expect(f.signTx).not.toHaveBeenCalled();
  });
  it("invalidates an in-flight transaction signature on account change", async () => {
    const f = await fixture(); await f.select(); const pending = deferred<readonly SolanaSignTransactionOutput[]>();
    f.signTx.mockReturnValue(pending.promise); const signing = f.controller.signTransaction(await f.prepared());
    const rejection = expect(signing).rejects.toThrow("changed"); f.emit({ accounts: [f.otherAccount] });
    await rejection; pending.resolve([]); expect(mock.send).not.toHaveBeenCalled();
  });
  it("does not retry a rejected transaction prompt or send anything", async () => {
    const f = await fixture(); await f.select(); f.signTx.mockRejectedValue(new Error("User declined transaction"));
    await expect(f.controller.signTransaction(await f.prepared())).rejects.toThrow("User declined transaction");
    expect(f.signTx).toHaveBeenCalledTimes(1); expect(mock.send).not.toHaveBeenCalled();
  });
  it("rejects silent account public-key mutation and pre-aborted requests before wallet invocation", async () => {
    const f = await fixture(); await f.select(); const prepared = await f.prepared(); const signal = AbortSignal.abort();
    await expect(f.controller.signTransaction(prepared, signal)).rejects.toThrow(); expect(f.signTx).not.toHaveBeenCalled();
    f.state.accounts = [{ ...f.account, publicKey: f.otherAccount.publicKey }];
    await expect(f.controller.signTransaction(prepared)).rejects.toThrow("capabilities changed");
  });
});
