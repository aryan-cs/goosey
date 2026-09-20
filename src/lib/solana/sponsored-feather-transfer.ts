import {
  AccountRole,
  address,
  createSolanaRpc,
  getBase64Decoder,
  getBase64Encoder,
  type Address,
  type Instruction,
  type TransactionPartialSigner,
} from "@solana/kit";
import { getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { readGooseyConfiguration } from "@/lib/solana/configuration";
import { buildFeatherTransfer, MAX_TOKEN_BASE_UNITS } from "@/lib/solana/feather-transfer";
import { resolveSolanaRuntime, type SolanaRuntime } from "@/lib/solana/runtime";
import {
  signSponsoredTransaction,
  type SignedSponsoredTransaction,
  type SponsoredTransactionAllowlist,
} from "@/lib/solana/sponsored-transaction";

const ZERO = "11111111111111111111111111111111";

function finalizedContext(slot: bigint, minimum: bigint): void {
  if (typeof slot !== "bigint" || slot < minimum || slot > MAX_TOKEN_BASE_UNITS) {
    throw new Error("Invalid finalized managed transfer context");
  }
}

function transferAllowlist(instructions: readonly Instruction[]): SponsoredTransactionAllowlist {
  if (instructions.length !== 2) throw new Error("Managed feather transfer requires exactly two instructions");
  const programs = [...new Set(instructions.map(instruction => instruction.programAddress))];
  if (programs.length !== 2 || !programs.includes(TOKEN_PROGRAM_ADDRESS)) {
    throw new Error("Managed feather transfer has an unexpected instruction program set");
  }
  const roles = new Map<Address, AccountRole>();
  for (const instruction of instructions) {
    for (const account of instruction.accounts ?? []) {
      if ("lookupTableAddress" in account) throw new Error("Managed feather transfers cannot use lookup tables");
      const accountAddress = address(account.address);
      roles.set(accountAddress, (roles.get(accountAddress) === undefined
        ? account.role : roles.get(accountAddress)! | account.role) as AccountRole);
    }
  }
  return Object.freeze({
    instructionProgramAddresses: Object.freeze(programs),
    requiredInstructionProgramAddresses: Object.freeze(programs),
    accounts: Object.freeze([...roles].map(([accountAddress, maxRole]) => Object.freeze({
      address: accountAddress,
      maxRole,
    }))),
    maxInstructions: 2,
  });
}

export type PreparedSponsoredFeatherTransfer = Readonly<{
  signed: SignedSponsoredTransaction;
  mint: Address;
  sender: Address;
  recipient: Address;
  source: Address;
  destination: Address;
  amount: bigint;
  finalizedBalance: bigint;
  observedSlot: bigint;
}>;

/**
 * Reads finalized token state, builds the canonical ATA-create plus checked SPL
 * transfer, and signs it with the app-managed participant and fee sponsor. It
 * never submits, journals, invents a balance, or mutates SQL accounting.
 */
export async function prepareSponsoredFeatherTransfer(input: Readonly<{
  runtime: SolanaRuntime;
  participant: TransactionPartialSigner;
  sponsor: TransactionPartialSigner;
  recipient: Address;
  amount: bigint;
  signal?: AbortSignal;
}>): Promise<PreparedSponsoredFeatherTransfer> {
  if (typeof input.amount !== "bigint" || input.amount <= 0n || input.amount > MAX_TOKEN_BASE_UNITS) {
    throw new Error("Managed transfer amount must be a positive feather u64");
  }
  const supplied = { ...input.runtime };
  const participantAddress = address(input.participant.address);
  const sponsorAddress = address(input.sponsor.address);
  const recipient = address(input.recipient);
  if (recipient === participantAddress || recipient === ZERO) throw new Error("Choose another nonzero transfer recipient");
  if (participantAddress === sponsorAddress) throw new Error("Participant and sponsor must be distinct");
  const runtime = resolveSolanaRuntime({
    GOOSEY_SOLANA_CLUSTER: supplied.cluster,
    GOOSEY_SOLANA_RPC_URL: supplied.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: supplied.programAddress,
    GOOSEY_SOLANA_GENESIS_HASH: supplied.genesisHash,
  });
  const signal = input.signal ?? AbortSignal.timeout(15_000);
  signal.throwIfAborted();
  const configuration = await readGooseyConfiguration(runtime, signal);
  finalizedContext(configuration.finalizedSlot, 0n);
  if (input.participant.address !== participantAddress || input.sponsor.address !== sponsorAddress) {
    throw new Error("Managed transfer signer identity changed during preparation");
  }
  const plan = await buildFeatherTransfer({
    mint: configuration.featherMint,
    sender: input.participant,
    payer: input.sponsor,
    recipient,
    amount: input.amount,
  });
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const source = await rpc.getAccountInfo(plan.source, {
    encoding: "base64",
    commitment: "finalized",
    minContextSlot: configuration.finalizedSlot,
  }).send({ abortSignal: signal });
  finalizedContext(source.context.slot, configuration.finalizedSlot);
  if (!source.value || source.value.executable || source.value.owner !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error("Sender feather account is missing or has an unexpected owner");
  }
  if (!Array.isArray(source.value.data) || source.value.data.length !== 2 || source.value.data[1] !== "base64"
    || typeof source.value.data[0] !== "string" || source.value.data[0].length !== 220) {
    throw new Error("Unsupported sender token encoding");
  }
  const bytes = new Uint8Array(getBase64Encoder().encode(source.value.data[0]));
  if (bytes.length !== 165 || getBase64Decoder().decode(bytes) !== source.value.data[0]) {
    throw new Error("Unsupported sender token account");
  }
  const options = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (![0, 1].includes(options.getUint32(72, true)) || options.getUint32(109, true) !== 0
    || ![0, 1].includes(options.getUint32(129, true))) {
    throw new Error("Unsupported sender token options");
  }
  const token = getTokenDecoder().decode(bytes);
  if (token.mint !== configuration.featherMint || token.owner !== participantAddress || token.state !== 1) {
    throw new Error("Sender feather account is not an initialized, unfrozen account for this custody wallet and mint");
  }
  if (token.amount < input.amount) throw new Error("Insufficient finalized feather balance");
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("Solana RPC genesis changed during managed transfer preparation");
  }
  if (input.participant.address !== participantAddress || input.sponsor.address !== sponsorAddress) {
    throw new Error("Managed transfer signer identity changed before signing");
  }
  const signed = await signSponsoredTransaction({
    runtime,
    participant: input.participant,
    sponsor: input.sponsor,
    instructions: plan.instructions,
    allowlist: transferAllowlist(plan.instructions),
    signal,
  });
  return Object.freeze({
    signed,
    mint: configuration.featherMint,
    sender: participantAddress,
    recipient,
    source: plan.source,
    destination: plan.destination,
    amount: plan.amount,
    finalizedBalance: token.amount,
    observedSlot: source.context.slot,
  });
}
