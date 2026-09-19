import { address } from "@solana/kit";
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { authRouteError, InvalidRequestError, jsonError } from "@/lib/http";
import { ApiError, requireUser } from "@/lib/market-service";
import { assertMutationOrigin, enforceRateLimit, identityRateLimitKey, InvalidOriginError, requestRateLimitKey } from "@/lib/security";
import { readGooseyConfiguration } from "@/lib/solana/configuration";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import { WALLET_CHALLENGE_STATEMENT } from "@/lib/solana/wallet-challenge";
import { WalletLinkError, type WalletLinkConfiguration, type LinkedSolanaWallet } from "@/lib/solana/wallet-link-service";

export const walletAddressSchema = z.string().min(32).max(44).transform((value, ctx) => {
  try { return address(value); } catch { ctx.addIssue({ code: "custom", message: "Invalid wallet address" }); return z.NEVER; }
});
const base64 = (maxBytes: number, exact = false) => z.string().min(4).max(4 * Math.ceil(maxBytes / 3)).refine(value => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value && (exact ? bytes.length === maxBytes : bytes.length <= maxBytes);
});
const isoDate = z.string().max(30).datetime().refine(value => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});
export const verifySchema = z.object({
  challengeId: z.string().uuid(),
  challenge: z.object({
    domain: z.string().min(1).max(253), uri: z.string().url().max(2048), version: z.literal("1"),
    chainId: z.enum(["solana:localnet", "solana:devnet"]), genesisHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    walletAddress: walletAddressSchema, statement: z.literal(WALLET_CHALLENGE_STATEMENT), nonce: z.string().regex(/^[0-9a-f]{64}$/),
    issuedAt: isoDate, expirationTime: isoDate, resources: z.tuple([z.string().max(100)]), message: z.string().min(1).max(4096),
  }).strict(),
  signedMessageBase64: base64(4096), signatureBase64: base64(64, true),
}).strict();

export function privateResponse(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.append("Vary", "Cookie");
  return response;
}

export function walletConfiguration() {
  if (!process.env.GOOSEY_SOLANA_CLUSTER) throw new ApiError(503, "SOLANA_DISABLED", "Wallet linking is disabled.");
  try {
    const runtime = resolveSolanaRuntime();
    // No Host, forwarded headers or NEXT_PUBLIC fallback defines signed identity.
    if (!process.env.APP_URL) throw new Error("Missing canonical origin");
    const url = new URL(process.env.APP_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Invalid canonical origin");
    }
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("Production wallet linking requires HTTPS");
    const configuration: WalletLinkConfiguration = { origin: url.origin, chainId: `solana:${runtime.cluster}`, genesisHash: runtime.genesisHash };
    return { runtime, configuration };
  } catch { throw new ApiError(503, "SOLANA_UNAVAILABLE", "Wallet linking is unavailable."); }
}

export async function walletAuthentication(request: NextRequest, mutation: boolean) {
  if (mutation) assertMutationOrigin(request);
  const user = await requireUser(request);
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionToken || sessionToken.length > 512) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
  return { userId: user.id, sessionToken };
}

export async function mutationGate(request: NextRequest, userId: string, action: "challenge" | "verify") {
  const { runtime, configuration } = walletConfiguration();
  if (request.headers.get("origin") !== configuration.origin) throw new InvalidOriginError();
  await enforceRateLimit(requestRateLimitKey(request, `wallet:${action}:ip`), 30, 15 * 60_000);
  await enforceRateLimit(identityRateLimitKey(`wallet:${action}:user`, userId), 10, 15 * 60_000);
  try { await readGooseyConfiguration(runtime); }
  catch { throw new ApiError(503, "SOLANA_UNAVAILABLE", "Wallet linking is unavailable."); }
  return configuration;
}

export function publicLink(link: Omit<LinkedSolanaWallet, "userId">) {
  return { id: link.id, chainId: link.chainId, genesisHash: link.genesisHash, walletAddress: link.walletAddress, verifiedAt: link.verifiedAt };
}

export function walletError(error: unknown) {
  if (error instanceof ZodError || error instanceof InvalidRequestError) return privateResponse(jsonError(400, "INVALID_REQUEST", "Invalid wallet-link request."));
  if (error instanceof WalletLinkError) {
    const messages = {
      AUTHENTICATION_REQUIRED: [401, "Sign in again before linking a wallet."],
      REAUTHENTICATION_REQUIRED: [401, "Enter your current password to link a wallet."],
      EMAIL_VERIFICATION_REQUIRED: [403, "Verify your email before linking a wallet."],
      INVALID_CHALLENGE: [400, "Wallet ownership could not be verified."],
      CHALLENGE_EXPIRED: [410, "Wallet challenge expired. Request a new challenge."],
      CHALLENGE_ALREADY_USED: [409, "Wallet challenge already used. Refresh linked wallets."],
      WALLET_LINK_CONFLICT: [409, "Wallet linking conflicts with an existing association."],
    } as const;
    const [status, message] = messages[error.code];
    return privateResponse(jsonError(status, error.code, message));
  }
  if (error instanceof ApiError) {
    const messages: Record<string, string> = { AUTHENTICATION_REQUIRED: "Sign in to continue.", EMAIL_VERIFICATION_REQUIRED: "Verify your email to continue.",
      SOLANA_DISABLED: "Wallet linking is disabled.", SOLANA_UNAVAILABLE: "Wallet linking is unavailable." };
    if (messages[error.code]) return privateResponse(jsonError(error.status, error.code, messages[error.code]));
  }
  return privateResponse(authRouteError(error));
}
