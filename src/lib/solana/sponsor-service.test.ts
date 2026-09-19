import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadSolanaSponsorSigner, SolanaSponsorConfigurationError } from "./sponsor-service";

function secretKeyBytes() {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  if (!jwk.d || !jwk.x) throw new Error("Failed to export test key");
  return Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]);
}

describe("Solana sponsor configuration", () => {
  it("fails closed when configuration is absent or malformed", async () => {
    await expect(loadSolanaSponsorSigner({})).rejects.toThrow(SolanaSponsorConfigurationError);
    await expect(loadSolanaSponsorSigner({
      GOOSEY_SOLANA_SPONSOR_ADDRESS: "11111111111111111111111111111111",
      GOOSEY_SOLANA_SPONSOR_SECRET_KEY: "not-base64",
    })).rejects.toThrow(SolanaSponsorConfigurationError);
  });

  it("loads only a canonical secret bound to the configured address", async () => {
    const secret = secretKeyBytes();
    try {
      const base64 = secret.toString("base64");
      const provisional = await loadSolanaSponsorSigner({
        GOOSEY_SOLANA_SPONSOR_ADDRESS: "11111111111111111111111111111111",
        GOOSEY_SOLANA_SPONSOR_SECRET_KEY: base64,
      }).catch(error => error);
      expect(provisional).toBeInstanceOf(SolanaSponsorConfigurationError);

      const { createKeyPairSignerFromBytes } = await import("@solana/kit");
      const expected = await createKeyPairSignerFromBytes(secret);
      const loaded = await loadSolanaSponsorSigner({
        GOOSEY_SOLANA_SPONSOR_ADDRESS: expected.address,
        GOOSEY_SOLANA_SPONSOR_SECRET_KEY: base64,
      });
      expect(loaded.address).toBe(expected.address);
    } finally {
      secret.fill(0);
    }
  });
});
