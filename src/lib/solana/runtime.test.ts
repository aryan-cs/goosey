import { describe, expect, it, vi } from "vitest";
import { address, getAddressEncoder } from "@solana/kit";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH, probeSolanaRuntime, resolveSolanaRuntime, type SolanaProbeClient } from "./runtime";

const env = {
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: "BPFLoaderUpgradeab1e11111111111111111111111",
  GOOSEY_SOLANA_GENESIS_HASH: "11111111111111111111111111111111",
};

describe("explicit non-mainnet Solana configuration", () => {
  it("uses actual full 32-byte network pins and rejects shortened identifiers", () => {
    expect(DEVNET_GENESIS_HASH).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    expect(MAINNET_GENESIS_HASH).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    expect(TESTNET_GENESIS_HASH).toBe("4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY");
    for (const pin of [DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH]) {
      expect(getAddressEncoder().encode(address(pin))).toHaveLength(32);
      expect(() => resolveSolanaRuntime({ ...env, GOOSEY_SOLANA_GENESIS_HASH: pin.slice(0, 32) })).toThrow();
      expect(() => resolveSolanaRuntime({ ...env, GOOSEY_SOLANA_CLUSTER: "devnet", GOOSEY_SOLANA_RPC_URL: "https://api.devnet.solana.com",
        GOOSEY_SOLANA_GENESIS_HASH: pin === DEVNET_GENESIS_HASH ? pin.slice(0, 32) : pin })).toThrow();
    }
  });
  it("requires configuration rather than silently selecting a network", () => {
    expect(() => resolveSolanaRuntime({})).toThrow("explicitly");
    expect(() => resolveSolanaRuntime({ ...env, GOOSEY_SOLANA_CLUSTER: "mainnet-beta" })).toThrow("unsupported");
  });
  it.each(["https://example.com", "http://127.0.0.1.evil.test:8899", "file:///tmp/rpc", "http://user:secret@localhost:8899", "http://localhost:8899/#fragment"])("rejects unsafe local RPC %s", (rpc) => {
    expect(() => resolveSolanaRuntime({ ...env, GOOSEY_SOLANA_RPC_URL: rpc })).toThrow();
  });
  it("accepts IPv6 loopback without selecting devnet", () => {
    expect(resolveSolanaRuntime({ ...env, GOOSEY_SOLANA_RPC_URL: "http://[::1]:8899" }).cluster).toBe("localnet");
  });
  it.each([undefined, "", "bad", MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH, TESTNET_GENESIS_HASH])("rejects invalid local genesis %s", (hash) => {
    expect(() => resolveSolanaRuntime({ ...env, GOOSEY_SOLANA_GENESIS_HASH: hash })).toThrow();
  });
  it("pins devnet and requires TLS", () => {
    const dev = { ...env, GOOSEY_SOLANA_CLUSTER: "devnet", GOOSEY_SOLANA_RPC_URL: "https://api.devnet.solana.com", GOOSEY_SOLANA_GENESIS_HASH: undefined };
    expect(resolveSolanaRuntime(dev).genesisHash).toBe(DEVNET_GENESIS_HASH);
    expect(resolveSolanaRuntime({ ...dev, GOOSEY_SOLANA_GENESIS_HASH: DEVNET_GENESIS_HASH }).genesisHash).toBe(DEVNET_GENESIS_HASH);
    expect(() => resolveSolanaRuntime({ ...dev, GOOSEY_SOLANA_GENESIS_HASH: env.GOOSEY_SOLANA_GENESIS_HASH })).toThrow();
    expect(() => resolveSolanaRuntime({ ...dev, GOOSEY_SOLANA_RPC_URL: "http://api.devnet.solana.com" })).toThrow("HTTPS");
  });
  it("rejects malformed program addresses", () => {
    expect(() => resolveSolanaRuntime({ ...env, GOOSEY_SOLANA_PROGRAM_ID: "not-a-program" })).toThrow("address");
  });
});

function fixtureRpc({ hash = env.GOOSEY_SOLANA_GENESIS_HASH, executable = true, owner = "BPFLoaderUpgradeab1e11111111111111111111111", missing = false } = {}) {
  const genesisSend = vi.fn().mockResolvedValue(hash);
  const accountSend = vi.fn().mockResolvedValue({ context: { slot: 9007199254740993n }, value: missing ? null : { executable, owner } });
  const getAccountInfo = vi.fn(() => ({ send: accountSend }));
  const rpc = { getGenesisHash: vi.fn(() => ({ send: genesisSend })), getAccountInfo } as unknown as SolanaProbeClient;
  return { rpc, genesisSend, accountSend, getAccountInfo };
}

describe("read-only deployment probe (mock transport contract, not chain execution)", () => {
  it("keeps exact finalized slot and never claims exchange verification", async () => {
    const fixture = fixtureRpc();
    const result = await probeSolanaRuntime(resolveSolanaRuntime(env), fixture.rpc);
    expect(result.finalizedSlot).toBe("9007199254740993");
    expect(result.exchangeVerified).toBe(false);
    expect(fixture.getAccountInfo).toHaveBeenCalledWith(env.GOOSEY_SOLANA_PROGRAM_ID, expect.objectContaining({ commitment: "finalized" }));
  });
  it("refuses the wrong network before reading program state", async () => {
    const fixture = fixtureRpc({ hash: MAINNET_GENESIS_HASH });
    await expect(probeSolanaRuntime(resolveSolanaRuntime(env), fixture.rpc)).rejects.toThrow("genesis mismatch");
    expect(fixture.getAccountInfo).not.toHaveBeenCalled();
  });
  it.each([{ missing: true }, { executable: false }, { owner: "11111111111111111111111111111111" }])("rejects absent/non-program accounts %o", async (options) => {
    await expect(probeSolanaRuntime(resolveSolanaRuntime(env), fixtureRpc(options).rpc)).rejects.toThrow();
  });
  it("propagates cancellation to every RPC request", async () => {
    const fixture = fixtureRpc();
    const signal = new AbortController().signal;
    await probeSolanaRuntime(resolveSolanaRuntime(env), fixture.rpc, signal);
    expect(fixture.genesisSend).toHaveBeenCalledWith({ abortSignal: signal });
    expect(fixture.accountSend).toHaveBeenCalledWith({ abortSignal: signal });
  });
  it("never treats an RPC error as a successful probe", async () => {
    const fixture = fixtureRpc();
    fixture.genesisSend.mockRejectedValue(new Error("RPC unavailable"));
    await expect(probeSolanaRuntime(resolveSolanaRuntime(env), fixture.rpc)).rejects.toThrow("RPC unavailable");
    expect(fixture.getAccountInfo).not.toHaveBeenCalled();
  });
});
