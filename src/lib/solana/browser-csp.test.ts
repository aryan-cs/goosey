import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import configureNext from "../../../next.config";
import { DEVNET_GENESIS_HASH } from "./runtime";

beforeEach(() => {
  vi.stubEnv("GOOSEY_SOLANA_BROWSER_ENABLED", "true");
  vi.stubEnv("GOOSEY_SOLANA_CLUSTER", "devnet");
  vi.stubEnv("GOOSEY_SOLANA_PROGRAM_ID", "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
  vi.stubEnv("GOOSEY_SOLANA_GENESIS_HASH", DEVNET_GENESIS_HASH);
  vi.stubEnv("GOOSEY_SOLANA_RPC_URL", "https://private.example/private-credential");
  vi.stubEnv("GOOSEY_SOLANA_PUBLIC_RPC_URL", "https://public.example/public-route");
});
afterEach(() => vi.unstubAllEnvs());
async function policy(phase = PHASE_PRODUCTION_BUILD) {
  const rules = await configureNext(phase).headers!();
  return rules.flatMap(rule => rule.headers).find(header => header.key === "Content-Security-Policy")!.value;
}
describe("explicit public RPC content security policy", () => {
  it.each([PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD])("permits exactly public origin (%s)", async phase => {
    const value = await policy(phase);
    expect(value.split(";").map(s => s.trim())).toContain("connect-src 'self' https://public.example");
    expect(value).not.toContain("private.example"); expect(value).not.toContain("credential");
    expect(value).not.toContain("public-route");
  });
  it("keeps self-only when disabled even if public URL is configured", async () => {
    vi.stubEnv("GOOSEY_SOLANA_BROWSER_ENABLED", "false");
    expect(await policy()).toContain("connect-src 'self';");
  });
  it.each(["https://*.example", "https://public.example;other", "https://public.example/?key=secret", "https://user:secret@public.example", "https://public.example/#secret"])("rejects unsafe enabled URL %s", url => {
    vi.stubEnv("GOOSEY_SOLANA_PUBLIC_RPC_URL", url);
    expect(() => configureNext(PHASE_PRODUCTION_BUILD)).toThrow();
  });
  it("permits only the configured loopback port in localnet mode", async () => {
    vi.stubEnv("GOOSEY_SOLANA_CLUSTER", "localnet");
    vi.stubEnv("GOOSEY_SOLANA_GENESIS_HASH", "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm");
    vi.stubEnv("GOOSEY_SOLANA_RPC_URL", "http://127.0.0.1:18999/");
    vi.stubEnv("GOOSEY_SOLANA_PUBLIC_RPC_URL", "http://127.0.0.1:19009/");
    expect(await policy()).toContain("connect-src 'self' http://127.0.0.1:19009;");
  });
});
