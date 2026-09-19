import { address, getAddressDecoder, signature, type Address } from "@solana/kit";

// Exact emit! payload order from lib.rs, escrow.rs, exchange.rs,
// cancellation.rs and resolution.rs. No terms/proposal/approval events are
// invented: those instructions currently do not emit an Anchor event.
const schemas = {
  Configured: { config: "address", mint: "address", environment: "environment", genesisDomain: "hex32" },
  EnrollmentAuthorized: { wallet: "address", enrollment: "address", allowance: "u64", expiresAt: "i64" },
  FeathersClaimed: { wallet: "address", amount: "u64", lifetimeMinted: "u64" },
  MarketCreated: { market: "address", vault: "address", payoutMilli: "u64" },
  CashMoved: { market: "address", wallet: "address", amount: "u64", deposit: "bool", nonce: "u64" },
  TradeExecuted: { market: "address", makerOrderId: "u64", takerOrderId: "u64", makerSeat: "u64", takerSeat: "u64",
    quantity: "u64", yesPrice: "u64", makerFee: "u64", takerFee: "u64", makerOutcome: "outcome", makerAction: "action", takerOutcome: "outcome", takerAction: "action" },
  OrderExecuted: { market: "address", wallet: "address", orderId: "u64", nonce: "u64", filled: "u64", canceled: "u64", rested: "u64",
    disposition: "disposition", outcome: "outcome", action: "action", price: "u64" },
  RestingOrderRemoved: { market: "address", orderId: "u64", seat: "u64", remaining: "u64", reason: "removal" },
  OrderCanceled: { market: "address", wallet: "address", seat: "u64", orderId: "u64", reason: "cancelReason", ownerNonce: "optionU64",
    bookRevision: "u64", remaining: "u64", chainNotional: "u64", releasedCash: "u64", releasedYes: "u64", releasedNo: "u64" },
  ResolutionClaimed: { market: "address", seatIndex: "u32", wallet: "address", payoutMilli: "u64" },
  ResolutionFinalized: { market: "address", residualMilli: "u64" },
} as const;
type Name = keyof typeof schemas;
type Value<T> = T extends "address" ? Address : T extends "bool" ? boolean : T extends "hex32" ? string : T extends "optionU64" ? bigint | null : bigint;
export type GooseyProgramEvent = { [K in Name]: { kind: K } & { [F in keyof typeof schemas[K]]: Value<typeof schemas[K][F]> } }[Name];
type Position = { logIndex: number; invocationDepth: number; eventKey: string };
export type ProgramEventRecord = Position & ({ status: "known"; event: GooseyProgramEvent } | { status: "unknown"; discriminatorHex: string; dataBase64: string });
export const PROGRAM_EVENT_LIMITS = Object.freeze({ logs: 4096, lineBytes: 8192, totalBytes: 524288, eventBytes: 4096, depth: 64 });
const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2, "0")).join("");
let discriminators: Promise<Map<string, Name>> | undefined;
function eventNames() {
  return discriminators ??= Promise.all((Object.keys(schemas) as Name[]).map(async name => [
    hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`event:${name}`))).slice(0, 8)), name,
  ] as const)).then(entries => new Map(entries));
}
function base64(value: string): Uint8Array {
  if (value.length > Math.ceil(PROGRAM_EVENT_LIMITS.eventBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Malformed program event base64");
  const binary = atob(value);
  if (btoa(binary) !== value || binary.length < 8 || binary.length > PROGRAM_EVENT_LIMITS.eventBytes) throw new Error("Invalid program event bytes");
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function decode(name: Name, bytes: Uint8Array): GooseyProgramEvent {
  let offset = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const take = (n: number) => { if (offset + n > bytes.length) throw new Error(`Truncated ${name} event`); const start = offset; offset += n; return start; };
  const byte = () => bytes[take(1)];
  const u64 = () => view.getBigUint64(take(8), true);
  const event: Record<string, unknown> = { kind: name };
  for (const [field, type] of Object.entries(schemas[name])) {
    if (type === "address") { const at = take(32); event[field] = getAddressDecoder().decode(bytes.subarray(at, at + 32)); }
    else if (type === "hex32") { const at = take(32); event[field] = hex(bytes.subarray(at, at + 32)); }
    else if (type === "u64") event[field] = u64();
    else if (type === "i64") event[field] = view.getBigInt64(take(8), true);
    else if (type === "u32") event[field] = BigInt(view.getUint32(take(4), true));
    else if (type === "optionU64") { const tag = byte(); if (tag > 1) throw new Error(`Invalid ${name} option`); event[field] = tag === 0 ? null : u64(); }
    else {
      const n = byte(), max = type === "disposition" ? 7 : type === "cancelReason" || type === "environment" ? 2 : 1;
      if (n > max || (type === "environment" && n === 0)) throw new Error(`Invalid ${name}.${field} tag`);
      event[field] = type === "bool" ? n === 1 : BigInt(n);
    }
  }
  if (offset !== bytes.length) throw new Error(`Trailing bytes in ${name} event`);
  return event as GooseyProgramEvent;
}

/** Caller supplies trusted RPC transaction metadata obtained at finalized
 * commitment. This pure function cannot authenticate logs/finality itself.
 * Reject incomplete/inconsistent traces, including truncation: never publish
 * partial events. Failure rolls back all descendant events, even a successful
 * nested invocation inside a later-failing parent CPI. Replay keys are stable;
 * caller must persist deduplication keyed by genesis+program+signature+logIndex.
 */
export async function decodeFinalizedProgramEvents(input: {
  programAddress: Address; genesisHash: string; signature: string; slot: bigint; commitment: "finalized";
  meta: { err: unknown; logMessages: readonly string[] | null };
}) {
  const program = address(input.programAddress), txSignature = signature(input.signature), slot = input.slot, genesis = input.genesisHash;
  if (input.commitment !== "finalized" || typeof slot !== "bigint" || slot < 0n) throw new Error("Finalized transaction metadata required");
  if (typeof genesis !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesis)) throw new Error("Invalid genesis domain");
  address(genesis); // A genesis hash must decode to exactly 32 bytes, like a public key.
  if (!input.meta || input.meta.err === undefined) throw new Error("Transaction execution status required");
  if (input.meta.err !== null) return { status: "failed-transaction" as const, signature: txSignature, slot, records: [] as ProgramEventRecord[] };
  if (!Array.isArray(input.meta.logMessages) || input.meta.logMessages.length > PROGRAM_EVENT_LIMITS.logs) throw new Error("Missing or excessive transaction logs");
  const logs = [...input.meta.logMessages]; let total = 0;
  for (const line of logs) {
    if (typeof line !== "string" || line.length > PROGRAM_EVENT_LIMITS.lineBytes || /[\r\n\0]/.test(line)) throw new Error("Invalid transaction log line");
    const size = new TextEncoder().encode(line).length; total += size;
    if (size > PROGRAM_EVENT_LIMITS.lineBytes || total > PROGRAM_EVENT_LIMITS.totalBytes) throw new Error("Transaction log size exceeded");
  }
  type Pending = { data: string; logIndex: number; invocationDepth: number };
  const stack: { program: Address; pending: Pending[] }[] = [], committed: Pending[] = [];
  for (const [logIndex, line] of logs.entries()) {
    if (line === "Log truncated" || line.startsWith("Log truncated")) throw new Error("Truncated transaction logs");
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[([1-9][0-9]*)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth !== stack.length + 1 || depth > PROGRAM_EVENT_LIMITS.depth) throw new Error("Invalid invocation depth");
      stack.push({ program: address(invoke[1]), pending: [] }); continue;
    }
    const exit = /^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/.exec(line);
    if (exit) {
      const frame = stack.pop();
      if (!frame || frame.program !== address(exit[1])) throw new Error("Mismatched program invocation exit");
      if (exit[2] === "success") (stack.at(-1)?.pending ?? committed).push(...frame.pending);
      else if (stack.length === 0) throw new Error("Top-level failure contradicts successful transaction metadata");
      continue;
    }
    if (/^Program [1-9A-HJ-NP-Za-km-z]+ (?:invoke|success|failed)(?:\b|:)/.test(line)) throw new Error("Malformed program invocation trace");
    if (line.startsWith("Program data: ")) {
      const frame = stack.at(-1);
      if (!frame) throw new Error("Unattributed program data");
      if (frame.program === program) frame.pending.push({ data: line.slice(14), logIndex, invocationDepth: stack.length });
    } else if (line.startsWith("Program data:") && (!stack.length || stack.at(-1)?.program === program)) throw new Error("Malformed program data log");
    // Program log: ... is application text, NEVER invocation/data syntax.
  }
  if (stack.length) throw new Error("Incomplete transaction invocation trace");
  const names = await eventNames(), records: ProgramEventRecord[] = [];
  for (const entry of committed) {
    const bytes = base64(entry.data), discriminatorHex = hex(bytes.subarray(0, 8)), name = names.get(discriminatorHex);
    const position = { logIndex: entry.logIndex, invocationDepth: entry.invocationDepth,
      eventKey: `${genesis}:${program}:${txSignature}:${entry.logIndex}` };
    records.push(name ? { ...position, status: "known", event: decode(name, bytes) }
      : { ...position, status: "unknown", discriminatorHex, dataBase64: entry.data });
  }
  return { status: "decoded" as const, signature: txSignature, slot, records };
}
