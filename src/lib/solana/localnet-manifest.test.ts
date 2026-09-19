import { describe, expect, it } from "vitest";
import { address, getAddressEncoder } from "@solana/kit";
import { elfHash, localnetManifestSchema, privateDirectory, verifyLocalnetProgramData } from "./localnet-manifest";

const admin = "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q";
const enrollment = "SysvarRent111111111111111111111111111111111";
const manifest = { version: 1, program: admin, admin, enrollment, validatorVersion: "test-only",
  artifactSha256: "a".repeat(64), rpcPort: 31000, perWalletCap: "1000", campaignCap: "10000" };
describe("localnet operator manifest (pure fixtures, not chain evidence)", () => {
  it("retains exact u64 caps and explicit port", () => {
    expect(localnetManifestSchema.parse({ ...manifest, campaignCap: "18446744073709551615" }).campaignCap).toBe("18446744073709551615");
  });
  it.each([8080, 8040, 18999, 18959, 19000, 19900, 65500, 0, 30000.5])("rejects unsafe port block %s", rpcPort => {
    expect(() => localnetManifestSchema.parse({ ...manifest, rpcPort })).toThrow();
  });
  it.each(["0", "-1", "1.1", "01", "1e3", "18446744073709551616"])("rejects cap %s", perWalletCap => {
    expect(() => localnetManifestSchema.parse({ ...manifest, perWalletCap })).toThrow();
  });
  it("rejects under-cap, same authorities, unknown properties and malformed key/hash", () => {
    for (const patch of [{ campaignCap: "1" }, { enrollment: admin }, { reset: true }, { admin: "bad" }, { artifactSha256: "bad" }]) {
      expect(() => localnetManifestSchema.parse({ ...manifest, ...patch })).toThrow();
    }
  });
  it.each(["relative", "/", "/tmp/../private", "/tmp/a\nb", "/tmp/a/"])("rejects unsafe directory %s", directory => {
    expect(() => privateDirectory(directory)).toThrow();
  });
  it("accepts normalized absolute directory", () => expect(privateDirectory("/private/tmp/localnet-instance")).toBe("/private/tmp/localnet-instance"));
  const elf = Buffer.from("7f454c4600010203", "hex");
  function data() {
    const bytes = Buffer.alloc(45 + elf.length + 8); bytes.writeUInt32LE(3); bytes[12] = 1;
    bytes.set(getAddressEncoder().encode(address(admin)), 13); bytes.set(elf, 45); return bytes;
  }
  it("matches exact deployed code with optional zero allocation padding", () => {
    expect(() => verifyLocalnetProgramData(data(), admin, elf)).not.toThrow();
    expect(() => verifyLocalnetProgramData(data().subarray(0, 45 + elf.length), admin, elf)).not.toThrow();
    expect(elfHash(elf)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects loader variant, absent/wrong authority, truncation and code/padding mutations", () => {
    for (const offset of [0, 12, 13, 45, 45 + elf.length]) {
      const bytes = data(); bytes[offset] ^= 1;
      expect(() => verifyLocalnetProgramData(bytes, admin, elf)).toThrow();
    }
    expect(() => verifyLocalnetProgramData(data().subarray(0, 46), admin, elf)).toThrow();
    expect(() => verifyLocalnetProgramData(data(), enrollment, elf)).toThrow();
  });
});
