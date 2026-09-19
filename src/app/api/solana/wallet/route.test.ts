import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), issue: vi.fn(), consume: vi.fn(), find: vi.fn(), read: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE_NAME: "goosey_session" }));
vi.mock("@/lib/market-service", () => ({
  ApiError: class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } },
  requireUser: mocks.user, prisma: { solanaWalletLink: { findMany: mocks.find } },
}));
vi.mock("@/lib/security", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/security")>();
  return { ...original, enforceRateLimit: mocks.rate, requestRateLimitKey: () => "ip", identityRateLimitKey: (_: string, id: string) => `user:${id}` };
});
vi.mock("@/lib/solana/configuration", () => ({ readGooseyConfiguration: mocks.read }));
vi.mock("@/lib/solana/wallet-link-service", () => ({
  issueWalletLinkChallenge: mocks.issue, consumeWalletLinkChallenge: mocks.consume,
  WalletLinkError: class WalletLinkError extends Error { constructor(public code: string, message: string) { super(message); } },
}));
import { ApiError } from "@/lib/market-service";
import { RateLimitError } from "@/lib/security";
import { WalletLinkError } from "@/lib/solana/wallet-link-service";
import { createWalletChallenge } from "@/lib/solana/wallet-challenge";
import { GET } from "./route";
import { POST as challengePost } from "./challenge/route";
import { POST as verifyPost } from "./verify/route";

const origin = "https://goosey.example";
const walletAddress = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const genesisHash = "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm";
const challenge = createWalletChallenge({ origin, chainId: "solana:localnet", genesisHash, walletAddress });
const id = "550e8400-e29b-41d4-a716-446655440000";
const link = { id: "link-id", userId: "user-1", chainId: "solana:localnet", genesisHash, walletAddress, verifiedAt: new Date() };
const validBody = () => ({ challengeId: id, challenge, signedMessageBase64: Buffer.from(challenge.message).toString("base64"), signatureBase64: Buffer.alloc(64, 1).toString("base64") });
function request(body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${origin}/api/solana/wallet`, { method: body === undefined ? "GET" : "POST",
    headers: { origin, cookie: "goosey_session=current-session", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_URL", origin); vi.stubEnv("GOOSEY_SOLANA_CLUSTER", "localnet");
  vi.stubEnv("GOOSEY_SOLANA_RPC_URL", "http://127.0.0.1:18999");
  vi.stubEnv("GOOSEY_SOLANA_PROGRAM_ID", "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
  vi.stubEnv("GOOSEY_SOLANA_GENESIS_HASH", genesisHash);
  mocks.user.mockResolvedValue({ id: "user-1" }); mocks.read.mockResolvedValue({});
  mocks.issue.mockResolvedValue({ id, challenge }); mocks.consume.mockResolvedValue(link); mocks.find.mockResolvedValue([link]);
});
afterEach(() => vi.unstubAllEnvs());

describe("authenticated Solana wallet linking routes (mocked service/RPC)", () => {
  it("rejects a production HTTP signing origin without touching the wallet service", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("APP_URL", "http://goosey.example");
    const response = await GET(request());
    expect(response.status).toBe(503); expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("issues only after verified deployment, using canonical APP_URL not Host", async () => {
    const response = await challengePost(request({ walletAddress }, { host: "evil.example", "x-forwarded-host": "evil.example" }));
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ id, challenge });
    expect(mocks.issue).toHaveBeenCalledWith({ authentication: { userId: "user-1", sessionToken: "current-session" },
      configuration: { origin, chainId: "solana:localnet", genesisHash }, walletAddress });
    expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(mocks.issue.mock.invocationCallOrder[0]!);
    expect(mocks.rate).toHaveBeenCalledTimes(2);
    expect(response.headers.get("cache-control")).toContain("private, no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
  });
  it("passes full signed challenge and current session, returning only public link fields", async () => {
    const response = await verifyPost(request(validBody()));
    expect(response.status).toBe(200);
    expect(mocks.consume).toHaveBeenCalledWith({ ...validBody(), authentication: { userId: "user-1", sessionToken: "current-session" },
      configuration: { origin, chainId: "solana:localnet", genesisHash } });
    const json = await response.json(); expect(json.wallet.walletAddress).toBe(walletAddress);
    expect(json.wallet).not.toHaveProperty("userId"); expect(json).not.toHaveProperty("balance");
  });
  it("GET scopes own links to configured genesis and never runs issuance or live RPC", async () => {
    const response = await GET(request()); expect(response.status).toBe(200);
    expect(mocks.find).toHaveBeenCalledWith({ where: { userId: "user-1", chainId: "solana:localnet", genesisHash },
      select: { id: true, chainId: true, genesisHash: true, walletAddress: true, verifiedAt: true }, orderBy: { verifiedAt: "desc" }, take: 1 });
    expect((await response.json()).items[0]).not.toHaveProperty("userId");
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated and unverified users before service/DB work", async () => {
    for (const [status, code] of [[401, "AUTHENTICATION_REQUIRED"], [403, "EMAIL_VERIFICATION_REQUIRED"]] as const) {
      mocks.user.mockRejectedValue(new ApiError(status, code, "internal detail"));
      for (const response of [await GET(request()), await challengePost(request({ walletAddress })), await verifyPost(request(validBody()))]) {
        expect(response.status).toBe(status); expect(await response.text()).not.toContain("internal detail");
      }
    }
    expect(mocks.issue).not.toHaveBeenCalled(); expect(mocks.consume).not.toHaveBeenCalled(); expect(mocks.find).not.toHaveBeenCalled();
  });
  it("requires cookie even if an upstream authentication mock supplies a user", async () => {
    expect((await challengePost(request({ walletAddress }, { cookie: "" }))).status).toBe(401);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("rejects cross-origin and missing-origin POST, including otherwise allowed alternate origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://alternate.example");
    for (const bad of ["https://evil.example", "", "https://alternate.example"]) {
      expect((await challengePost(request({ walletAddress }, { origin: bad }))).status).toBe(403);
      expect((await verifyPost(request(validBody(), { origin: bad }))).status).toBe(403);
    }
    expect(mocks.issue).not.toHaveBeenCalled(); expect(mocks.consume).not.toHaveBeenCalled();
  });
  it("fails disabled/unconfigured/RPC gates closed with sanitized 503", async () => {
    vi.stubEnv("GOOSEY_SOLANA_CLUSTER", "");
    expect((await challengePost(request({ walletAddress }))).status).toBe(503);
    expect((await GET(request())).status).toBe(503);
    vi.stubEnv("GOOSEY_SOLANA_CLUSTER", "localnet");
    for (const bad of ["", "https://user:secret@goosey.example", "https://goosey.example/path"]) {
      vi.stubEnv("APP_URL", bad); expect((await challengePost(request({ walletAddress }))).status).toBe(503);
    }
    vi.stubEnv("APP_URL", origin); mocks.read.mockRejectedValue(new Error("rpc://secret-provider-key"));
    const response = await verifyPost(request(validBody())); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret-provider-key");
    expect(mocks.issue).not.toHaveBeenCalled(); expect(mocks.consume).not.toHaveBeenCalled();
  });
  it("enforces rate limit with Retry-After and no challenge mutation", async () => {
    mocks.rate.mockRejectedValue(new RateLimitError(30));
    const response = await challengePost(request({ walletAddress }));
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("30");
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("strictly validates challenge and canonical base64 plus bounded JSON bodies", async () => {
    for (const body of [{ walletAddress, userId: "other" }, { walletAddress: "bad" }, { walletAddress: [walletAddress] }, { walletAddress, junk: "x".repeat(17_000) }]) {
      expect((await challengePost(request(body))).status).toBe(400);
    }
    for (const body of [{ ...validBody(), userId: "other" }, { ...validBody(), challenge: { ...challenge, extra: true } },
      { ...validBody(), challenge: { message: challenge.message } }, { ...validBody(), challenge: { ...challenge, issuedAt: "not-a-date" } }, { ...validBody(), signatureBase64: "AQ==" },
      { ...validBody(), signedMessageBase64: "!!!!" }, { ...validBody(), signatureBase64: Buffer.alloc(64).toString("base64").replace(/==$/, "=") },
      { ...validBody(), signedMessageBase64: Buffer.alloc(4097).toString("base64") }]) {
      expect((await verifyPost(request(body))).status).toBe(400);
    }
    expect((await challengePost(request({ walletAddress }, { "content-type": "text/plain" }))).status).toBe(400);
    expect(mocks.issue).not.toHaveBeenCalled(); expect(mocks.consume).not.toHaveBeenCalled();
  });
  it.each([["INVALID_CHALLENGE", 400], ["CHALLENGE_EXPIRED", 410], ["CHALLENGE_ALREADY_USED", 409], ["WALLET_LINK_CONFLICT", 409],
    ["AUTHENTICATION_REQUIRED", 401], ["EMAIL_VERIFICATION_REQUIRED", 403]] as const)("maps %s without leaking service details", async (code, status) => {
    mocks.consume.mockRejectedValue(new WalletLinkError(code, "private key database detail"));
    const response = await verifyPost(request(validBody())); expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private key database detail");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("sanitizes unexpected failures", async () => {
    mocks.issue.mockRejectedValue(new Error("secret database URL"));
    const response = await challengePost(request({ walletAddress })); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret database URL");
  });
});
