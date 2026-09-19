// Node-only filesystem retention. Never import this module into client bundles.
import { constants } from "node:fs";
import { lstat, open, realpath, link, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { address } from "@solana/kit";
import { MARKET_TERMS_MAX_BYTES, verifyMarketTerms } from "./market-terms";

export type RetainedMarketTermsExpectation = Parameters<typeof verifyMarketTerms>[1] & { manifestLength: number };
export class MarketTermsRetentionConflict extends Error {
  readonly code = "MARKET_TERMS_RETENTION_CONFLICT";
  constructor() { super("Different immutable terms already retained for this market/deployment"); this.name = "MarketTermsRetentionConflict"; }
}
function capture(expected: RetainedMarketTermsExpectation) {
  const copy = structuredClone(expected);
  if (!Number.isInteger(copy.manifestLength) || copy.manifestLength < 1 || copy.manifestLength > MARKET_TERMS_MAX_BYTES
    || typeof copy.digest !== "string" || !/^[0-9a-f]{64}$/.test(copy.digest)) throw new Error("Invalid retained terms expectation");
  for (const field of [copy.binding.genesisHash, copy.binding.program, copy.binding.market]) address(field);
  return copy;
}
function filename(expected: RetainedMarketTermsExpectation) {
  // Market-keyed, not just content-addressed: a second digest for the SAME market
  // must conflict, while other programs/genesis ledgers remain independent.
  const identity = JSON.stringify([expected.binding.genesisHash, expected.binding.program, expected.binding.market]);
  return createHash("sha256").update("goosey:retained-market-terms:v1\0").update(identity).digest("hex") + ".json";
}
async function directory(root: string) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) === path.parse(root).root) throw new Error("Explicit private terms directory required");
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error("Terms directory must be an owned private directory (0700)");
  return realpath(root);
}
async function readBounded(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MARKET_TERMS_MAX_BYTES) throw new Error("Invalid retained terms file type/size");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    // Removing the publisher's staging hard link legitimately changes ctime and
    // nlink while a concurrent idempotent reader holds the final inode open.
    // Content is independently authenticated below by exact canonical hash.
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Retained terms changed during read");
    return new Uint8Array(bytes.subarray(0, count));
  } finally { await handle.close(); }
}
async function verify(bytes: Uint8Array, expected: RetainedMarketTermsExpectation) {
  if (bytes.length !== expected.manifestLength) throw new Error("Retained manifest length mismatch");
  return verifyMarketTerms(bytes, expected);
}

/** Serve these exact bytes, not reserialized JSON or a mutable source URL.
 * Expected digest/length/bindings must come from a trusted finalized chain read.
 * No RPC/finality claim is made here; replicas/backups are an operator concern.
 * Root must pre-exist, be private, and have trusted ancestors. Node does not
 * expose openat/linkat: concurrent hostile replacement of ancestors is outside
 * this local single-owner store's contract. Symlink leaves are rejected.
 */
export async function readRetainedMarketTerms(root: string, expectation: RetainedMarketTermsExpectation) {
  const expected = capture(expectation), rootInput = root;
  const dir = await directory(rootInput), file = path.join(dir, filename(expected));
  const bytes = await readBounded(file), terms = await verify(bytes, expected);
  return { bytes, terms, digest: expected.digest, manifestLength: bytes.length };
}

/** Validate first, write an exclusive private staging file, fsync it, then
 * atomically publish via a no-overwrite hard link and fsync the directory.
 * Readers never see a partly written final file. Same bytes are idempotent;
 * conflicting bytes are never overwritten. Files are published read-only.
 * An fsync failure throws (durability uncertain); retry the same content.
 * A crash may leave a private .pending file; never treat it as published terms.
 * Filesystem owner/root can still alter files: every read verifies hash/content.
 */
export async function retainMarketTerms(root: string, input: Uint8Array, expectation: RetainedMarketTermsExpectation) {
  if (!(input instanceof Uint8Array) || input.length < 1 || input.length > MARKET_TERMS_MAX_BYTES) throw new Error("Invalid retained terms bytes");
  const bytes = new Uint8Array(input), expected = capture(expectation), rootInput = root;
  await verify(bytes, expected);
  const dir = await directory(rootInput), file = path.join(dir, filename(expected));
  const temporary = path.join(dir, `.terms-${randomUUID()}.pending`);
  const dirHandle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let ownsTemporary = false;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    ownsTemporary = true;
    try { await handle.writeFile(bytes); await handle.chmod(0o444); await handle.sync(); }
    finally { await handle.close(); }
    let created = true;
    try { await link(temporary, file); }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      const existing = await readBounded(file);
      if (existing.length !== bytes.length || !existing.every((byte, index) => byte === bytes[index])) throw new MarketTermsRetentionConflict();
      await verify(existing, expected); created = false;
    }
    await dirHandle.sync();
    return { created, digest: expected.digest, manifestLength: bytes.length };
  } finally {
    try { if (ownsTemporary) { await unlink(temporary); await dirHandle.sync(); } }
    finally { await dirHandle.close(); }
  }
}
