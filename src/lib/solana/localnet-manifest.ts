/** Node-only operator metadata. Never import retained keys into the web app. */
import { z } from "zod";
import path from "node:path";
import { createHash } from "node:crypto";
import { address, getAddressDecoder } from "@solana/kit";

const key = z.string().refine(value => { try { address(value); return true; } catch { return false; } });
const amount = z.string().regex(/^[1-9][0-9]*$/).refine(v => BigInt(v) <= (1n << 64n) - 1n);
export const localnetManifestSchema = z.object({
  version: z.literal(1), program: key, admin: key, enrollment: key,
  validatorVersion: z.string().min(1).max(200), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rpcPort: z.number().int().min(1024).max(65495).refine(base =>
    ![8080, 18999, 19000, 19900].some(port => port >= base && port <= base + 40)),
  perWalletCap: amount, campaignCap: amount,
}).strict().refine(v => BigInt(v.campaignCap) >= BigInt(v.perWalletCap), "Campaign cap must cover per-wallet cap")
  .refine(v => v.admin !== v.enrollment, "Authorities must be separate");
export type LocalnetManifest = z.infer<typeof localnetManifestSchema>;
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
