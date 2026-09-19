/** Node-only operator metadata. Never import retained keys into the web app. */
import { z } from "zod";
import path from "node:path";
import { createHash } from "node:crypto";
import { address, getAddressDecoder } from "@solana/kit";

const key = z.string().refine(value => { try { address(value); return true; } catch { return false; } });
const amount = z.string().regex(/^[1-9][0-9]*$/).refine(v => BigInt(v) <= (1n << 64n) - 1n);
// Shreds are the validator's pruning unit, NOT a byte/age or total-disk quota.
export const DEFAULT_LOCALNET_LEDGER_SHREDS = 1_000_000;
export const MAX_LOCALNET_LEDGER_SHREDS = 10_000_000;
const ledgerShredLimit = z.number().int().min(10_000).max(MAX_LOCALNET_LEDGER_SHREDS);
export function parseLocalnetLedgerShreds(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LOCALNET_LEDGER_SHREDS;
  if (!/^[1-9][0-9]{0,7}$/.test(value)) throw new Error("Expected canonical bounded ledger shred count");
  return ledgerShredLimit.parse(Number(value));
}
export const localnetManifestSchema = z.object({
  version: z.literal(1), program: key, admin: key, enrollment: key,
  validatorVersion: z.string().min(1).max(200), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rpcPort: z.number().int().min(1024).max(65495).refine(base =>
    ![8080, 18999, 19000, 19900].some(port => port >= base && port <= base + 40)),
  perWalletCap: amount, campaignCap: amount,
  // Legacy v1 manifests omitted this field. Interpret them with the documented
  // bounded default on restart; never rewrite their immutable manifest.
  ledgerShredLimit: ledgerShredLimit.default(DEFAULT_LOCALNET_LEDGER_SHREDS),
}).strict().refine(v => BigInt(v.campaignCap) >= BigInt(v.perWalletCap), "Campaign cap must cover per-wallet cap")
  .refine(v => v.admin !== v.enrollment, "Authorities must be separate");
export type LocalnetManifest = z.infer<typeof localnetManifestSchema>;
export function localnetLedgerArguments(manifest: LocalnetManifest): string[] {
  return ["--limit-ledger-size", String(ledgerShredLimit.parse(manifest.ledgerShredLimit))];
}
export function privateDirectory(value: string) {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value.endsWith(path.sep) || value === path.parse(value).root
    || /[\r\n\0]/.test(value)) throw new Error("Use an explicit normalized absolute private directory");
  return value;
}
export const elfHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function verifyLocalnetProgramData(data: Uint8Array, authority: string, elf: Uint8Array) {
  const bytes = Buffer.from(data);
  if (bytes.length < 45 + elf.length || bytes.readUInt32LE(0) !== 3 || bytes[12] !== 1
    || getAddressDecoder().decode(bytes.subarray(13, 45)) !== authority
    || !bytes.subarray(45, 45 + elf.length).equals(Buffer.from(elf))
    || bytes.subarray(45 + elf.length).some(byte => byte !== 0)) {
    throw new Error("Deployed ProgramData authority/code differs from pinned artifact");
  }
}
