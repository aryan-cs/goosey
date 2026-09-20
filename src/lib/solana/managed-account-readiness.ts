import { createHmac } from "node:crypto";

import type { TransactionPartialSigner } from "@solana/kit";

import {
  provisionManagedSolanaAccount,
  type ProvisioningResult,
} from "@/lib/solana/account-provisioning";
import { PrismaProvisioningJournal } from "@/lib/solana/provisioning-journal";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import {
  loadSolanaEnrollmentAuthoritySigner,
  loadSolanaSponsorSigner,
} from "@/lib/solana/sponsor-service";

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

type Dependencies = Readonly<{
  journal?: PrismaProvisioningJournal;
  loadEnrollmentAuthority?: (env: Record<string, string | undefined>) => Promise<TransactionPartialSigner>;
  loadSponsor?: (env: Record<string, string | undefined>) => Promise<TransactionPartialSigner>;
  provision?: typeof provisionManagedSolanaAccount;
}>;

function positiveDecimal(value: string | undefined, label: string, maximum: bigint): bigint {
  if (!value || !/^[1-9][0-9]{0,19}$/.test(value)) throw new Error(`${label} is not configured`);
  const parsed = BigInt(value);
  if (parsed > maximum) throw new Error(`${label} is out of range`);
  return parsed;
}

export function managedIdentityDigest(
  userId: string,
  genesisHash: string,
  secretValue: string | undefined,
): Uint8Array {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(userId)
    || !secretValue || !/^[A-Za-z0-9_-]{43}$/.test(secretValue)) {
    throw new Error("Managed identity digest configuration is invalid");
  }
  const secret = Buffer.from(secretValue, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== secretValue) {
    secret.fill(0);
    throw new Error("Managed identity digest configuration is invalid");
  }
  try {
    return new Uint8Array(createHmac("sha256", secret)
      .update("goosey-managed-solana-identity-v1\0", "utf8")
      .update(userId, "utf8")
      .update("\0", "utf8")
      .update(genesisHash, "utf8")
      .digest());
  } finally {
    secret.fill(0);
  }
}

/** Drives enrollment and the one-time free-feather claim to finalized state.
 * The durable journal makes each invocation resumable after process failure. */
export async function ensureManagedFeatherAccountReady(input: Readonly<{
  userId: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}>, dependencies: Dependencies = {}): Promise<ProvisioningResult> {
  const env = input.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const identityDigest = managedIdentityDigest(input.userId, runtime.genesisHash,
    env.GOOSEY_SOLANA_IDENTITY_DIGEST_SECRET);
  const allowance = positiveDecimal(env.GOOSEY_SOLANA_USER_FEATHER_ALLOWANCE,
    "GOOSEY_SOLANA_USER_FEATHER_ALLOWANCE", U64_MAX);
  const expiresAt = positiveDecimal(env.GOOSEY_SOLANA_ENROLLMENT_EXPIRES_AT,
    "GOOSEY_SOLANA_ENROLLMENT_EXPIRES_AT", I64_MAX);
  const [enrollmentAuthority, sponsor] = await Promise.all([
    (dependencies.loadEnrollmentAuthority ?? loadSolanaEnrollmentAuthoritySigner)(env),
    (dependencies.loadSponsor ?? loadSolanaSponsorSigner)(env),
  ]);
  if (enrollmentAuthority.address === sponsor.address) {
    throw new Error("Enrollment authority and fee sponsor must be distinct");
  }
  const journal = dependencies.journal ?? new PrismaProvisioningJournal();
  const provision = dependencies.provision ?? provisionManagedSolanaAccount;
  let result: ProvisioningResult | null = null;
  // Enrollment and claim are separate finalized transactions. Three passes are
  // sufficient for absent -> enrollment pending -> claim pending -> ready.
  for (let pass = 0; pass < 3; pass += 1) {
    input.signal?.throwIfAborted();
    result = await provision({ userId: input.userId, identityDigest, allowance, expiresAt,
      enrollmentAuthority, sponsor, journal, env, signal: input.signal });
    if (result.status === "ready") return result;
    if (result.status === "manual-reconciliation-required") {
      throw new Error("Managed feather provisioning requires transaction reconciliation");
    }
  }
  if (!result) throw new Error("Managed feather provisioning did not start");
  return result;
}
