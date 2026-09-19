import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH } from "./runtime";

export const MARKET_TERMS_VERSION = 1 as const;
export const MARKET_TERMS_MAX_BYTES = 24_576;
export const MARKET_TERMS_HASH_DOMAIN = "goosey:market-terms:sha256:v1\0";
type Reviewer = { wallet: string; enrollment: string };
export type MarketTermsBinding = {
  cluster: "localnet" | "devnet"; genesisHash: string; program: string; config: string;
  market: string; marketId: string; creator: string; featherMint: string;
};
export type MarketTerms = {
  version: 1; binding: MarketTermsBinding; question: string;
  rules: { yes: string; no: string; void: string };
  observation: { startsAt: string; endsAt: string; timezone: "UTC" };
  sources: { id: string; uri: string; selection: string; snapshotSha256: string | null }[];
  sourcePolicy: { priority: "array-order-first-authoritative"; missing: string; revisions: string };
  economics: { payoutMilli: string; feeBps: string; closesAt: string; resolvesAt: string; decimals: 3 };
  oracle: { kind: "two-reviewer-no-fallback-v1"; proposer: Reviewer; approver: Reviewer;
    unavailable: "wait-for-designated-reviewers"; replacement: "none"; automaticVoid: false };
};
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ZERO = "11111111111111111111111111111111";
const U64 = (1n << 64n) - 1n, I64 = (1n << 63n) - 1n;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Expected plain terms object");
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) throw new Error("Unexpected/missing terms field");
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !("value" in d)) throw new Error("Terms fields must be enumerable data properties");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value
    || value.normalize("NFC") !== value || /[\p{Cc}\p{Cf}]/u.test(value.replace(/\n/g, ""))) throw new Error("Invalid canonical terms text");
  const bytes = encoder.encode(value);
  if (bytes.length > max || decoder.decode(bytes) !== value) throw new Error("Invalid/bounded UTF-8 terms text");
  return value;
}
function literal<T extends string | number | boolean>(value: unknown, expected: T): T {
  if (value !== expected) throw new Error(`Expected terms literal ${expected}`);
  return expected;
}
function integer(value: unknown, max: bigint, min = 0n): string {
  if (typeof value !== "string" || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)
    || BigInt(value) > max || BigInt(value) < min) throw new Error("Invalid canonical integer string");
  return value;
}
function key(value: unknown): string {
  if (typeof value !== "string" || value === ZERO) throw new Error("Invalid nonzero terms address");
  return address(value);
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value) || /^0+$/.test(value)) throw new Error("Expected nonzero lowercase SHA-256 hex");
  return value;
}
function reviewer(value: unknown): Reviewer {
  const v = record(value, ["wallet", "enrollment"]);
  return { wallet: key(v.wallet), enrollment: key(v.enrollment) };
}
function binding(value: unknown): MarketTermsBinding {
  const v = record(value, ["cluster", "genesisHash", "program", "config", "market", "marketId", "creator", "featherMint"]);
  if (v.cluster !== "localnet" && v.cluster !== "devnet") throw new Error("Unsupported terms cluster");
  if (typeof v.genesisHash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.genesisHash)
    || v.genesisHash === MAINNET_GENESIS_HASH
    || (v.cluster === "devnet" ? v.genesisHash !== DEVNET_GENESIS_HASH : v.genesisHash === DEVNET_GENESIS_HASH)) throw new Error("Invalid terms genesis binding");
  return { cluster: v.cluster, genesisHash: v.genesisHash, program: key(v.program), config: key(v.config),
    market: key(v.market), marketId: integer(v.marketId, U64), creator: key(v.creator), featherMint: key(v.featherMint) };
}
/** Validates and constructs fixed-key-order JSON. No coercion or silent Unicode normalization. */
function canonical(value: unknown): MarketTerms {
  const v = record(value, ["version", "binding", "question", "rules", "observation", "sources", "sourcePolicy", "economics", "oracle"]);
  const b = binding(v.binding), r = record(v.rules, ["yes", "no", "void"]);
  const o = record(v.observation, ["startsAt", "endsAt", "timezone"]);
  const e = record(v.economics, ["payoutMilli", "feeBps", "closesAt", "resolvesAt", "decimals"]);
  const p = record(v.sourcePolicy, ["priority", "missing", "revisions"]);
  const q = record(v.oracle, ["kind", "proposer", "approver", "unavailable", "replacement", "automaticVoid"]);
  if (!Array.isArray(v.sources) || v.sources.length < 1 || v.sources.length > 8
    || Reflect.ownKeys(v.sources).length !== v.sources.length + 1) throw new Error("Expected 1..8 dense priority-ordered sources");
  for (let i = 0; i < v.sources.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v.sources, String(i));
    if (!d || !d.enumerable || !("value" in d)) throw new Error("Source array must contain only dense data entries");
  }
  const sources = v.sources.map(source => {
    const s = record(source, ["id", "uri", "selection", "snapshotSha256"]);
    const id = text(s.id, 32), uri = text(s.uri, 512);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("Invalid source ID");
    const url = new URL(uri);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== uri) throw new Error("Source URI must be canonical credential-free HTTPS");
    return { id, uri, selection: text(s.selection, 1024), snapshotSha256: s.snapshotSha256 === null ? null : sha(s.snapshotSha256) };
  });
  if (new Set(sources.map(s => s.id)).size !== sources.length || new Set(sources.map(s => s.uri)).size !== sources.length) throw new Error("Duplicate sources");
  const result: MarketTerms = {
    version: literal(v.version, 1), binding: b, question: text(v.question, 512),
    rules: { yes: text(r.yes, 2048), no: text(r.no, 2048), void: text(r.void, 2048) },
    observation: { startsAt: integer(o.startsAt, I64), endsAt: integer(o.endsAt, I64), timezone: literal(o.timezone, "UTC") },
    sources, sourcePolicy: { priority: literal(p.priority, "array-order-first-authoritative"), missing: text(p.missing, 2048), revisions: text(p.revisions, 2048) },
    economics: { payoutMilli: integer(e.payoutMilli, 1_000_000n, 2n), feeBps: integer(e.feeBps, 10_000n),
      closesAt: integer(e.closesAt, I64), resolvesAt: integer(e.resolvesAt, I64), decimals: literal(e.decimals, 3) },
    oracle: { kind: literal(q.kind, "two-reviewer-no-fallback-v1"), proposer: reviewer(q.proposer), approver: reviewer(q.approver),
      unavailable: literal(q.unavailable, "wait-for-designated-reviewers"), replacement: literal(q.replacement, "none"), automaticVoid: literal(q.automaticVoid, false) },
  };
  if (BigInt(result.observation.startsAt) > BigInt(result.observation.endsAt)
    || BigInt(result.observation.endsAt) > BigInt(result.economics.resolvesAt)
    || BigInt(result.economics.closesAt) > BigInt(result.economics.resolvesAt)) throw new Error("Inconsistent observation/resolution times");
  const { proposer, approver } = result.oracle;
  if (proposer.wallet === approver.wallet || proposer.enrollment === approver.enrollment
    || proposer.wallet === b.creator || approver.wallet === b.creator) throw new Error("Conflicting terms reviewers");
  return result;
}
export function encodeMarketTerms(value: unknown): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(canonical(value)));
  if (bytes.length > MARKET_TERMS_MAX_BYTES) throw new Error("Terms manifest exceeds byte limit");
  return bytes;
}
export function decodeMarketTerms(bytes: Uint8Array): MarketTerms {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MARKET_TERMS_MAX_BYTES) throw new Error("Invalid terms byte length");
  const result = canonical(JSON.parse(decoder.decode(bytes)));
  const encoded = encodeMarketTerms(result);
  if (bytes.length !== encoded.length || !bytes.every((n, i) => n === encoded[i])) throw new Error("Noncanonical terms bytes");
  return result;
}
/** SHA256(UTF8(domain including NUL) || canonical bytes). Never hashes a URL instead. */
export async function hashMarketTerms(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array) || bytes.length > MARKET_TERMS_MAX_BYTES) throw new Error("Invalid terms bytes");
  const snapshot = new Uint8Array(bytes); decodeMarketTerms(snapshot);
  const domain = encoder.encode(MARKET_TERMS_HASH_DOMAIN), input = new Uint8Array(domain.length + snapshot.length);
  input.set(domain); input.set(snapshot, domain.length);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
/** Pure content/binding verification; caller must obtain expected values from a
 * trusted finalized chain snapshot. Does not establish RPC finality or truth. */
export async function verifyMarketTerms(bytes: Uint8Array, expected: { digest: string; binding: MarketTermsBinding;
  economics: MarketTerms["economics"]; proposer: Reviewer; approver: Reviewer }): Promise<MarketTerms> {
  if (!(bytes instanceof Uint8Array) || bytes.length > MARKET_TERMS_MAX_BYTES) throw new Error("Invalid terms bytes");
  const snapshot = new Uint8Array(bytes), terms = decodeMarketTerms(snapshot);
  // Capture all caller-owned expectations before the first await.
  const expectedDigest = sha(expected.digest), expectedBinding = binding(expected.binding);
  const expectedTerms = canonical({ ...terms, binding: expectedBinding, economics: expected.economics,
    oracle: { ...terms.oracle, proposer: expected.proposer, approver: expected.approver } });
  if (JSON.stringify(terms) !== JSON.stringify(expectedTerms)) throw new Error("Market terms binding/economics/reviewer mismatch");
  if (await hashMarketTerms(snapshot) !== expectedDigest) throw new Error("Market terms digest mismatch");
  const programAddress = address(terms.binding.program), enc = getAddressEncoder();
  const pda = async (seeds: Parameters<typeof getProgramDerivedAddress>[0]["seeds"]) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];
  const config = await pda(["config"]), id = new Uint8Array(8);
  new DataView(id.buffer).setBigUint64(0, BigInt(terms.binding.marketId), true);
  if (config !== terms.binding.config || await pda(["market", enc.encode(config), id]) !== terms.binding.market
    || await pda(["feather_mint", enc.encode(config)]) !== terms.binding.featherMint) throw new Error("Noncanonical market identity PDAs");
  for (const who of [terms.oracle.proposer, terms.oracle.approver]) {
    if (await pda(["enrollment", enc.encode(config), enc.encode(address(who.wallet))]) !== who.enrollment) throw new Error("Noncanonical reviewer enrollment PDA");
  }
  return terms;
}
