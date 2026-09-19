import { createHash } from "node:crypto";
import { address, getAddressEncoder, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { deriveGooseyProgramAddresses } from "./program-client";
import { verifyGooseyConfiguration } from "./configuration";

const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
  genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
// Codec fixtures only, never inserted into the chain or application database.
async function fixture() {
  const pda = await deriveGooseyProgramAddresses(runtime.programAddress);
  const config = Buffer.alloc(172), mint = Buffer.alloc(82);
  config.set(createHash("sha256").update("account:Config").digest().subarray(0, 8));
  config.set([1, 1, pda.configBump, pda.mintAuthorityBump], 8);
  config.set(createHash("sha256").update(runtime.genesisHash).digest(), 12);
  const encode = getAddressEncoder();
  config.set(encode.encode(TOKEN_PROGRAM_ADDRESS), 44);
  config.set(encode.encode(TOKEN_PROGRAM_ADDRESS), 76);
  config.set(encode.encode(pda.featherMint), 108);
  config.writeBigUInt64LE(1_000_000n, 140);
  config.writeBigUInt64LE(2_000_000n, 148);
  config.writeBigUInt64LE(2_000_000n, 156);
  config.writeBigUInt64LE(1_000_000n, 164);
  mint.writeUInt32LE(1, 0);
  mint.set(encode.encode(pda.mintAuthority), 4);
  mint.writeBigUInt64LE(1_000_000n, 36);
  mint[44] = 3; mint[45] = 1;
  const account = (data: Buffer, owner: Address = runtime.programAddress) => ({ owner, executable: false, data: [data.toString("base64"), "base64"] as const });
  return { config, mint, account, verify: () => verifyGooseyConfiguration(runtime, account(config), account(mint, TOKEN_PROGRAM_ADDRESS)) };
}
describe("finalized configuration codec constraints (not execution proof)", () => {
  it("decodes exact counters and canonical mint", async () => {
    const f = await fixture();
    expect(await f.verify()).toMatchObject({ totalAuthorized: 2_000_000n, totalMinted: 1_000_000n, supply: 1_000_000n });
  });
  it("permits burning without reopening lifetime issuance capacity", async () => {
    const f = await fixture(); f.mint.writeBigUInt64LE(2n, 36);
    expect(await f.verify()).toMatchObject({ supply: 2n, totalMinted: 1_000_000n });
  });
  it.each([0, 8, 9, 10, 11, 12, 108])("rejects discriminator/domain/seed/mint corruption at %i", async offset => {
    const f = await fixture(); f.config[offset] ^= 1;
    await expect(f.verify()).rejects.toThrow();
  });
  it.each([[140, 0n], [148, 1n], [156, 2_000_001n], [164, 2_000_001n]] as const)("rejects invalid counter %i", async (offset, value) => {
    const f = await fixture(); f.config.writeBigUInt64LE(value, offset);
    await expect(f.verify()).rejects.toThrow("supply constraints");
  });
  it.each([44, 76])("rejects zero authority %i", async offset => {
    const f = await fixture(); f.config.fill(0, offset, offset + 32);
    await expect(f.verify()).rejects.toThrow("authority");
  });
  it.each([0, 4, 44, 45, 46])("rejects token authority/decimals/state changes at %i", async offset => {
    const f = await fixture(); f.mint[offset] ^= 1;
    await expect(f.verify()).rejects.toThrow();
  });
  it("rejects supply exceeding lifetime program issuance", async () => {
    const f = await fixture(); f.mint.writeBigUInt64LE(1_000_001n, 36);
    await expect(f.verify()).rejects.toThrow("supply");
  });
  it("rejects missing, wrong-owner, executable, or trailing-data accounts", async () => {
    const f = await fixture(), mint = f.account(f.mint, TOKEN_PROGRAM_ADDRESS);
    for (const config of [null, f.account(f.config, TOKEN_PROGRAM_ADDRESS), { ...f.account(f.config), executable: true }, f.account(Buffer.concat([f.config, Buffer.alloc(1)]))]) {
      await expect(verifyGooseyConfiguration(runtime, config, mint)).rejects.toThrow();
    }
  });
  it("preserves counters above JavaScript number precision", async () => {
    const f = await fixture(), cap = (1n << 64n) - 1n;
    f.config.writeBigUInt64LE(cap, 148); f.config.writeBigUInt64LE(cap, 156); f.config.writeBigUInt64LE(cap, 164);
    f.mint.writeBigUInt64LE(cap, 36);
    expect(await f.verify()).toMatchObject({ campaignCap: cap, supply: cap });
  });
});
