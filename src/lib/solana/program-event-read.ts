import { address, createSolanaRpc, getAddressDecoder, getBase64Decoder, getBase64Encoder,
  getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder,
  getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder, getPublicKeyFromAddress, verifySignature, signature, type Address,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { verifyGooseyConfiguration } from "./configuration";
import { deriveGooseyProgramAddresses } from "./program-client";
import { decodeFinalizedProgramEvents, PROGRAM_EVENT_LIMITS, type ProgramEventRecord } from "./program-events";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";

export type ProgramEventReadRpc = Pick<ReturnType<typeof createSolanaRpc>,
  "getGenesisHash" | "getTransaction" | "getSlot" | "getMultipleAccounts">;
export type FinalizedProgramEventRecord = Extract<ProgramEventRecord, { status: "known" }>;
export type ProgramReceiptOutcome =
  | { outcome: "success"; records: FinalizedProgramEventRecord[] }
  | { outcome: "failed"; records: [] }
  | { outcome: "no-program-invocation"; records: [] };
const MAX_U64 = (1n << 64n) - 1n;
function u64(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) throw new Error("Invalid receipt integer/slot");
}
function canonicalBase64(value: unknown, max: number) {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(max / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid bounded base64 receipt");
  const bytes = getBase64Encoder().encode(value);
  if (bytes.length > max || getBase64Decoder().decode(bytes) !== value) throw new Error("Noncanonical receipt bytes");
  return bytes;
}
function accountEnvelope(account: unknown, owner: Address, size: number) {
  const a = account as { owner?: unknown; executable?: unknown; data?: unknown } | null;
  if (!a || a.owner !== owner || a.executable !== false || !Array.isArray(a.data)
    || a.data.length !== 2 || a.data[1] !== "base64" || canonicalBase64(a.data[0], size).length !== size) {
    throw new Error("Invalid configuration account envelope");
  }
}

// Validate failed traces too: the event decoder intentionally returns immediately
// on meta.err, so it cannot itself establish failed-receipt log completeness.
function receiptTrace(value: unknown, program: Address, failed: boolean) {
  if (!Array.isArray(value) || value.length > PROGRAM_EVENT_LIMITS.logs) throw new Error("Missing/excessive receipt logs");
  const stack: Address[] = [];
  let total = 0, invoked = false, terminalFailure = false;
  for (const line of value) {
    if (typeof line !== "string" || line.length > PROGRAM_EVENT_LIMITS.lineBytes || /[\r\n\0]/.test(line)) throw new Error("Malformed receipt log");
    const bytes = new TextEncoder().encode(line).length; total += bytes;
    if (bytes > PROGRAM_EVENT_LIMITS.lineBytes || total > PROGRAM_EVENT_LIMITS.totalBytes || line.startsWith("Log truncated")) throw new Error("Incomplete/oversized receipt logs");
    const enter = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[([1-9][0-9]*)\]$/.exec(line);
    if (enter) {
      if (terminalFailure || Number(enter[2]) !== stack.length + 1 || stack.length >= PROGRAM_EVENT_LIMITS.depth) throw new Error("Invalid receipt invocation trace");
      const key = address(enter[1]); stack.push(key); invoked ||= key === program; continue;
    }
    const exit = /^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/.exec(line);
    if (exit) {
      if (stack.pop() !== address(exit[1])) throw new Error("Mismatched receipt invocation exit");
      if (!stack.length && exit[2] !== "success") terminalFailure = true;
      continue;
    }
    if (/^Program [1-9A-HJ-NP-Za-km-z]+ (?:invoke|success|failed)(?:\b|:)/.test(line)) throw new Error("Malformed receipt invocation trace");
    if (line.startsWith("Program data:")) {
      if (!stack.length) throw new Error("Unattributed receipt data");
      if (stack.at(-1) === program) {
        if (!line.startsWith("Program data: ") || canonicalBase64(line.slice(14), PROGRAM_EVENT_LIMITS.eventBytes).length < 8) throw new Error("Malformed receipt event bytes");
      }
    }
  }
  if (stack.length || (!failed && terminalFailure)) throw new Error("Incomplete/inconsistent receipt trace");
  return { invoked, terminalFailure };
}

// Known wire error variants, not exception-message classification. Unknown
// variants remain nonterminal until explicitly supported. Kit keeps indexes and
// custom program codes as numbers; accept exact bigint RPC numeric values too.
function executionFailed(error: unknown, instructions: number, accounts: number): boolean {
  if (error === null) return false;
  const index = (n: unknown, max: number) => (typeof n === "number" && Number.isInteger(n) && n >= 0 && n < max)
    || (typeof n === "bigint" && n >= 0n && n < BigInt(max));
  const transactionErrors = new Set("AccountBorrowOutstanding AccountInUse AccountLoadedTwice AccountNotFound AddressLookupTableNotFound AlreadyProcessed BlockhashNotFound CallChainTooDeep ClusterMaintenance InsufficientFundsForFee InvalidAccountForFee InvalidAccountIndex InvalidAddressLookupTableData InvalidAddressLookupTableIndex InvalidAddressLookupTableOwner InvalidLoadedAccountsDataSizeLimit InvalidProgramForExecution InvalidRentPayingAccount InvalidWritableAccount MaxLoadedAccountsDataSizeExceeded MissingSignatureForFee ProgramAccountNotFound ResanitizationNeeded SanitizeFailure SignatureFailure TooManyAccountLocks UnbalancedTransaction UnsupportedVersion WouldExceedAccountDataBlockLimit WouldExceedAccountDataTotalLimit WouldExceedMaxAccountCostLimit WouldExceedMaxBlockCostLimit WouldExceedMaxVoteCostLimit".split(" "));
  const instructionErrors = new Set("AccountAlreadyInitialized AccountBorrowFailed AccountBorrowOutstanding AccountDataSizeChanged AccountDataTooSmall AccountNotExecutable AccountNotRentExempt ArithmeticOverflow BorshIoError BuiltinProgramsMustConsumeComputeUnits CallDepth ComputationalBudgetExceeded DuplicateAccountIndex DuplicateAccountOutOfSync ExecutableAccountNotRentExempt ExecutableDataModified ExecutableLamportChange ExecutableModified ExternalAccountDataModified ExternalAccountLamportSpend GenericError IllegalOwner Immutable IncorrectAuthority IncorrectProgramId InsufficientFunds InvalidAccountData InvalidAccountOwner InvalidArgument InvalidError InvalidInstructionData InvalidRealloc InvalidSeeds MaxAccountsDataAllocationsExceeded MaxAccountsExceeded MaxInstructionTraceLengthExceeded MaxSeedLengthExceeded MissingAccount MissingRequiredSignature ModifiedProgramId NotEnoughAccountKeys PrivilegeEscalation ProgramEnvironmentSetupFailure ProgramFailedToCompile ProgramFailedToComplete ReadonlyDataModified ReadonlyLamportChange ReentrancyNotAllowed RentEpochModified UnbalancedInstruction UninitializedAccount UnsupportedProgramId UnsupportedSysvar".split(" "));
  if (typeof error === "string" && transactionErrors.has(error)) return true;
  if (error && typeof error === "object" && !Array.isArray(error) && Object.keys(error).length === 1) {
    const [kind, detail] = Object.entries(error)[0];
    if (kind === "DuplicateInstruction" && index(detail, instructions)) return true;
    if ((kind === "InsufficientFundsForRent" || kind === "ProgramExecutionTemporarilyRestricted") && detail
      && typeof detail === "object" && Object.keys(detail).length === 1 && index(detail.account_index, accounts)) return true;
    if (kind === "InstructionError" && Array.isArray(detail) && detail.length === 2 && index(detail[0], instructions)) {
      const code: unknown = detail[1];
      if (typeof code === "string" && instructionErrors.has(code)) return true;
      if (code && typeof code === "object" && Object.keys(code).length === 1 && "Custom" in code && index(code.Custom, 2 ** 32)) return true;
    }
  }
  throw new Error("Malformed/unsupported transaction execution status");
}

/** Read-only ingestion boundary: finality is requested from RPC, never supplied
 * by the caller. The endpoint is still trusted for execution logs and consensus;
 * this is not a light-client proof or an attestation of the deployed binary.
 * Config/mint/program are checked in one CURRENT finalized snapshot at/after the
 * receipt slot, not falsely presented as historical state at execution time.
 * Failed and no-invocation receipts are verified terminal outcomes with no events.
 * Null/pruned, unsupported, unknown-event and incomplete receipts throw;
 * callers must not advance a durable cursor on these errors. Records carry stable
 * replay keys, but this function does not persist or perform deduplication.
 * Bounds apply to decoded fields; the RPC transport owns its HTTP response cap.
 */
export async function readFinalizedProgramEvents(runtime: SolanaRuntime, transactionSignature: string,
  options: { rpc?: ProgramEventReadRpc; signal?: AbortSignal } = {}) {
  // Revalidate and capture every caller-owned option before the first await.
  const pinned = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: runtime.cluster, GOOSEY_SOLANA_RPC_URL: runtime.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: runtime.programAddress, GOOSEY_SOLANA_GENESIS_HASH: runtime.genesisHash });
  const requested = signature(transactionSignature);
  const signal = options.signal ?? AbortSignal.timeout(15_000);
  const rpc = options.rpc ?? createSolanaRpc(pinned.rpcUrl);
  signal.throwIfAborted();
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== pinned.genesisHash) throw new Error("Event RPC genesis mismatch");
  signal.throwIfAborted();
  const receipt = await rpc.getTransaction(requested, { commitment: "finalized", encoding: "base64",
    maxSupportedTransactionVersion: 0 }).send({ abortSignal: signal });
  if (!receipt) throw new Error("Finalized transaction unavailable (not finalized, unknown or pruned)");
  u64(receipt.slot);
  const slot = receipt.slot;
  if (receipt.version !== "legacy" && receipt.version !== 0) throw new Error("Unsupported transaction version");
  if (receipt.blockTime !== null && (typeof receipt.blockTime !== "bigint" || receipt.blockTime < -(1n << 63n)
    || receipt.blockTime >= (1n << 63n))) throw new Error("Invalid transaction block time");
  if (!receipt.meta || receipt.meta.err === undefined) throw new Error("Missing transaction metadata");
  const meta = receipt.meta;
  u64(meta.fee);
  if (!Array.isArray(receipt.transaction) || receipt.transaction.length !== 2 || receipt.transaction[1] !== "base64") throw new Error("Invalid transaction encoding");
  const wire = canonicalBase64(receipt.transaction[0], 1232);
  const tx = getTransactionDecoder().decode(wire);
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (message.version !== receipt.version || getSignatureFromTransaction(tx) !== requested
    || getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !== receipt.transaction[0]
    || getBase64Decoder().decode(getCompiledTransactionMessageEncoder().encode(message)) !== getBase64Decoder().decode(tx.messageBytes)
    || Object.values(tx.signatures).some(value => value === null || value.every(byte => byte === 0))) throw new Error("Transaction signature/message mismatch");
  const lookups = message.version === 0 ? message.addressTableLookups ?? [] : [];
  const writableCount = lookups.reduce((n, lookup) => n + lookup.writableIndexes.length, 0);
  const readonlyCount = lookups.reduce((n, lookup) => n + lookup.readonlyIndexes.length, 0);
  const loaded = meta.loadedAddresses;
  if (!loaded || !Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly)
    || loaded.writable.length !== writableCount || loaded.readonly.length !== readonlyCount
    || message.staticAccounts.length + writableCount + readonlyCount > 256) throw new Error("Invalid loaded address metadata");
  const keys = [...message.staticAccounts, ...loaded.writable.map(key => address(key)), ...loaded.readonly.map(key => address(key))];
  const header = message.header;
  if (header.numSignerAccounts < 1 || header.numSignerAccounts > message.staticAccounts.length
    || header.numReadonlySignerAccounts >= header.numSignerAccounts
    || header.numReadonlyNonSignerAccounts > message.staticAccounts.length - header.numSignerAccounts
    || Object.keys(tx.signatures).length !== header.numSignerAccounts || new Set(keys).size !== keys.length
    || message.instructions.some(ix => ix.programAddressIndex >= keys.length
      || ix.accountIndices?.some(index => index >= keys.length))) throw new Error("Invalid transaction message accounts/header");
  if (!keys.includes(pinned.programAddress)) throw new Error("Receipt does not load configured program");
  const failed = executionFailed(meta.err, message.instructions.length, keys.length);
  for (const balances of [meta.preBalances, meta.postBalances]) {
    if (!Array.isArray(balances) || balances.length !== keys.length) throw new Error("Invalid receipt balance metadata");
    balances.forEach(u64);
  }
  // Decoder enforces bounded logs and complete invocation attribution. Do not
  // silently skip an unrecognized event: schema upgrades need explicit handling.
  const trace = receiptTrace(meta.logMessages, pinned.programAddress, failed);
  // A direct invocation cannot disappear from a successful receipt. This avoids
  // classifying empty/truncated traces as legitimate loaded-but-not-invoked txs.
  if (!failed && !trace.invoked && message.instructions.some(ix => keys[ix.programAddressIndex] === pinned.programAddress)) throw new Error("Missing direct program invocation logs");
  if (failed && !trace.terminalFailure && typeof meta.err === "object" && meta.err && "InstructionError" in meta.err) throw new Error("Missing instruction failure trace");
  const decoded = failed ? null : await decodeFinalizedProgramEvents({ programAddress: pinned.programAddress,
    genesisHash: pinned.genesisHash, signature: requested, slot, commitment: "finalized",
    meta: { err: null, logMessages: meta.logMessages ?? null } });
  if (decoded && (decoded.status !== "decoded" || decoded.records.some(record => record.status !== "known"))) throw new Error("Unsupported/unknown program event receipt");
  for (const [signer, sig] of Object.entries(tx.signatures)) {
    if (!sig || !await verifySignature(await getPublicKeyFromAddress(address(signer)), sig, tx.messageBytes)) throw new Error("Invalid transaction Ed25519 signature");
  }
  signal.throwIfAborted();
  const finalizedSlot = await rpc.getSlot({ commitment: "finalized" }).send({ abortSignal: signal });
  u64(finalizedSlot);
  if (finalizedSlot < slot) throw new Error("Receipt slot exceeds finalized RPC root");
  const addresses = await deriveGooseyProgramAddresses(pinned.programAddress);
  const snapshot = await rpc.getMultipleAccounts([pinned.programAddress, addresses.config, addresses.featherMint], {
    encoding: "base64", commitment: "finalized", minContextSlot: finalizedSlot,
  }).send({ abortSignal: signal });
  u64(snapshot.context.slot);
  if (snapshot.context.slot < finalizedSlot || !Array.isArray(snapshot.value) || snapshot.value.length !== 3) throw new Error("Invalid finalized configuration snapshot");
  const [program, config, mint] = snapshot.value;
  if (!program || program.executable !== true || program.owner !== "BPFLoaderUpgradeab1e11111111111111111111111"
    || !Array.isArray(program.data) || program.data.length !== 2 || program.data[1] !== "base64") throw new Error("Invalid program deployment binding");
  const programBytes = canonicalBase64(program.data[0], 36);
  if (programBytes.length !== 36 || programBytes[0] !== 2 || programBytes.slice(1,4).some(Boolean)) throw new Error("Invalid upgradeable program account");
  if (getAddressDecoder().decode(programBytes.subarray(4)) !== addresses.programData) throw new Error("Invalid canonical program-data binding");
  accountEnvelope(config, pinned.programAddress, 172); accountEnvelope(mint, TOKEN_PROGRAM_ADDRESS, 82);
  await verifyGooseyConfiguration(pinned, config, mint);
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== pinned.genesisHash) throw new Error("Event RPC genesis changed during read");
  signal.throwIfAborted();
  const terminal: ProgramReceiptOutcome = failed ? { outcome: "failed", records: [] }
    : !trace.invoked ? { outcome: "no-program-invocation", records: [] }
    : { outcome: "success", records: decoded!.records as FinalizedProgramEventRecord[] };
  return { signature: requested, slot, genesisHash: pinned.genesisHash, programAddress: pinned.programAddress,
    config: addresses.config, configurationSlot: snapshot.context.slot,
    ...terminal };
}
