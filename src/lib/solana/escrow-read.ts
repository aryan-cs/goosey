import { address, createSolanaRpc, getAddressDecoder, getAddressEncoder, getBase64Encoder, getBase64Decoder,
  getProgramDerivedAddress, type Address } from "@solana/kit";
import { AccountState, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { deriveGooseySeatAddresses } from "./escrow-client";
import { verifyGooseyConfiguration } from "./configuration";
import { probeSolanaRuntime, type SolanaRuntime } from "./runtime";
import { deriveGooseyBookAddress } from "./exchange-client";
import { readCanonicalOrderBook, GOOSEY_ORDER_BOOK_BYTES } from "./order-book-read";

export type EscrowReadRpc = Pick<ReturnType<typeof createSolanaRpc>, "getGenesisHash" | "getAccountInfo" | "getMultipleAccounts">;
export type EscrowReadInput = { marketId: bigint; wallet: Address };
export type EscrowChainAccount = { owner: Address; executable: boolean; data: readonly [string, "base64"] };
export type EscrowSnapshotAccounts = {
  config: EscrowChainAccount | null; mint: EscrowChainAccount | null; market: EscrowChainAccount | null;
  seats: EscrowChainAccount | null; locator: EscrowChainAccount | null; vault: EscrowChainAccount | null;
  walletTokens: EscrowChainAccount | null;
};
const ZERO = "11111111111111111111111111111111";
const key = (bytes: Uint8Array, offset: number) => getAddressDecoder().decode(bytes.subarray(offset, offset + 32));
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function raw(account: EscrowChainAccount | null, owner: Address, size: number) {
  if (!account || account.owner !== owner || account.executable !== false || !Array.isArray(account.data)
    || account.data.length !== 2 || account.data[1] !== "base64" || typeof account.data[0] !== "string"
    || account.data[0].length !== 4 * Math.ceil(size / 3)) throw new Error("Invalid escrow account owner/encoding/size");
  const bytes = new Uint8Array(getBase64Encoder().encode(account.data[0]));
  if (bytes.length !== size || getBase64Decoder().decode(bytes) !== account.data[0]) throw new Error("Invalid escrow account bytes");
  return bytes;
}
async function anchor(account: EscrowChainAccount | null, owner: Address, size: number, name: string) {
  const bytes = raw(account, owner, size);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`account:${name}`)));
  if (!bytes.subarray(0, 8).every((byte, index) => byte === hash[index])) throw new Error(`Wrong ${name} discriminator`);
  return bytes;
}
async function marketData(account: EscrowChainAccount | null, program: Address) {
  // Borsh: 8 discriminator + four pubkeys + seven u64/i64 + u16 + bump.
  const bytes = await anchor(account, program, 195, "Market"), data = view(bytes);
  return { config: key(bytes, 8), creator: key(bytes, 40), seats: key(bytes, 72), vault: key(bytes, 104),
    marketId: data.getBigUint64(136, true), payoutMilli: data.getBigUint64(144, true),
    closesAt: data.getBigInt64(152, true), resolvesAt: data.getBigInt64(160, true),
    accountedVault: data.getBigUint64(168, true), collateral: data.getBigUint64(176, true),
    feeRevenue: data.getBigUint64(184, true), feeBps: data.getUint16(192, true), bump: bytes[194] };
}
function token(account: EscrowChainAccount | null, mint: Address, owner: Address, vault: boolean) {
  const decoded = getTokenDecoder().decode(raw(account, TOKEN_PROGRAM_ADDRESS, 165));
  if (decoded.mint !== mint || decoded.owner !== owner || decoded.state !== AccountState.Initialized
    || decoded.isNative.__option !== "None") throw new Error("Invalid escrow token binding/state");
  if (vault && (decoded.delegate.__option !== "None" || decoded.closeAuthority.__option !== "None" || decoded.delegatedAmount !== 0n)) {
    throw new Error("Unexpected vault authority");
  }
  return decoded;
}

/** Verify one caller-supplied coherent snapshot at canonical addresses. This pure
 * verifier cannot establish RPC finality/network; use readGooseyEscrow for that.
 * Checks aggregate cash/collateral/positions, not complete order reserve backing:
 * that requires a coherent order-book reconciliation, which this reader does not do.
 */
export async function verifyGooseyEscrowSnapshot(runtime: SolanaRuntime, input: EscrowReadInput,
  seatsAddress: Address, accounts: EscrowSnapshotAccounts) {
  input = { ...input };
  const wallet = address(input.wallet);
  if (wallet === ZERO) throw new Error("Wallet must be nonzero");
  const addresses = await deriveGooseySeatAddresses({ ...input, wallet, programAddress: runtime.programAddress });
  // Strict envelope checks also cover accounts passed through the shared verifier.
  raw(accounts.config, runtime.programAddress, 172); raw(accounts.mint, TOKEN_PROGRAM_ADDRESS, 82);
  const configuration = await verifyGooseyConfiguration(runtime, accounts.config, accounts.mint);
  const market = await marketData(accounts.market, runtime.programAddress);
  if (market.config !== addresses.config || market.creator !== configuration.admin || market.marketId !== input.marketId
    || market.bump !== addresses.marketBump || market.vault !== addresses.vault || market.seats !== seatsAddress || market.seats === ZERO
    || market.payoutMilli < 2n || market.payoutMilli > 1_000_000n || market.feeBps > 10_000
    || market.closesAt <= 0n || market.resolvesAt < market.closesAt) throw new Error("Invalid market binding/parameters");
  const seats = await anchor(accounts.seats, runtime.programAddress, 32_816, "Seats"), seatData = view(seats);
  const count = seatData.getUint32(40, true);
  if (key(seats, 8) !== addresses.market || count > 256 || seats.subarray(44, 48).some(Boolean)) throw new Error("Invalid Seats header");
  const wallets = new Set<Address>();
  let totalCash = 0n, totalYes = 0n, totalNo = 0n;
  let selected: { index: number; availableCash: bigint; reservedCash: bigint; yes: bigint; no: bigint;
    reservedYes: bigint; reservedNo: bigint; nextNonce: bigint; everTraded: boolean } | null = null;
  for (let index = 0; index < 256; index++) {
    const offset = 48 + index * 128;
    if (index >= count) {
      if (seats.subarray(offset, offset + 128).some(Boolean)) throw new Error("Nonzero unused seat");
      continue;
    }
    const seatWallet = key(seats, offset), enrollment = key(seats, offset + 32);
    if (seatWallet === ZERO || wallets.has(seatWallet)) throw new Error("Invalid/duplicate seat wallet");
    wallets.add(seatWallet);
    const [expected] = await getProgramDerivedAddress({ programAddress: runtime.programAddress,
      seeds: ["enrollment", getAddressEncoder().encode(addresses.config), getAddressEncoder().encode(seatWallet)] });
    if (enrollment !== expected) throw new Error("Invalid seat enrollment PDA");
    const availableCash = seatData.getBigUint64(offset + 64, true), nextNonce = seatData.getBigUint64(offset + 112, true);
    const reservedCash = seatData.getBigUint64(offset + 72, true);
    // YES/NO are total holdings, inclusive of reserved positions. Cash differs:
    // available_cash excludes reserved_cash, so both enter the cash aggregate.
    const yes = seatData.getBigUint64(offset + 80, true), no = seatData.getBigUint64(offset + 88, true);
    const reservedYes = seatData.getBigUint64(offset + 96, true), reservedNo = seatData.getBigUint64(offset + 104, true);
    const everTraded = seats[offset + 120];
    if (everTraded > 1 || seats.subarray(offset + 121, offset + 128).some(Boolean)) throw new Error("Invalid seat flag/padding");
    if (reservedYes > yes || reservedNo > no) throw new Error("Reserved positions exceed total holdings");
    totalCash += availableCash + reservedCash;
    totalYes += yes; totalNo += no;
    if (seatWallet === wallet) selected = { index, availableCash, reservedCash, yes, no,
      reservedYes, reservedNo, nextNonce, everTraded: everTraded === 1 };
  }
  if (totalCash + market.collateral + market.feeRevenue !== market.accountedVault) {
    throw new Error("Seat cash, collateral and fees do not reconcile to accounted vault");
  }
  if (totalYes !== totalNo || totalYes * market.payoutMilli !== market.collateral) {
    throw new Error("Total YES/NO positions do not reconcile to collateral");
  }
  if (accounts.locator === null) {
    if (selected !== null) throw new Error("Missing locator for registered wallet");
  } else {
    const locator = await anchor(accounts.locator, runtime.programAddress, 77, "SeatLocator");
    if (!selected || key(locator, 8) !== addresses.market || key(locator, 40) !== wallet
      || view(locator).getUint32(72, true) !== selected.index || locator[76] !== addresses.locatorBump) throw new Error("Invalid seat locator binding");
  }
  const vault = token(accounts.vault, addresses.featherMint, addresses.market, true);
  const walletToken = accounts.walletTokens === null ? null : token(accounts.walletTokens, addresses.featherMint, wallet, false);
  if (vault.amount < market.accountedVault || vault.amount + (walletToken?.amount ?? 0n) > configuration.supply) {
    throw new Error("Vault backing/supply invariant violated");
  }
  return { ...addresses, seats: seatsAddress, wallet, marketState: market, seat: selected,
    vaultAmount: vault.amount, vaultSurplus: vault.amount - market.accountedVault,
    walletTokenAmount: walletToken?.amount ?? null, registered: selected !== null,
    exchangeVerified: false as const };
}

/** Discover the non-PDA Seats address, then RE-READ market and every balance in
 * one finalized batch. Never combine discovery balances with the final snapshot.
 * RPC trust remains necessary; this does not attest the deployed program binary.
 */
export async function readGooseyEscrow(runtime: SolanaRuntime, input: EscrowReadInput, options: {
  rpc?: EscrowReadRpc; signal?: AbortSignal; includeOrderBook?: boolean;
} = {}) {
  input = { ...input };
  runtime = { ...runtime };
  const includeOrderBook = options.includeOrderBook === true;
  const signal = options.signal ?? AbortSignal.timeout(8_000);
  signal.throwIfAborted();
  const rpc = options.rpc ?? createSolanaRpc(runtime.rpcUrl);
  const probe = await probeSolanaRuntime(runtime, rpc, signal);
  const addresses = await deriveGooseySeatAddresses({ ...input, programAddress: runtime.programAddress });
  const discovery = await rpc.getMultipleAccounts([addresses.market], { encoding: "base64", commitment: "finalized",
    minContextSlot: BigInt(probe.finalizedSlot) }).send({ abortSignal: signal });
  if (typeof discovery.context.slot !== "bigint" || discovery.context.slot < BigInt(probe.finalizedSlot) || discovery.value.length !== 1) {
    throw new Error("Invalid escrow discovery snapshot");
  }
  const market = await marketData(discovery.value[0], runtime.programAddress);
  const bookAddress = includeOrderBook ? (await deriveGooseyBookAddress(runtime.programAddress, addresses.market)).book : null;
  const response = await rpc.getMultipleAccounts([addresses.config, addresses.featherMint, addresses.market, market.seats,
    addresses.locator, addresses.vault, addresses.walletTokens, ...(bookAddress ? [bookAddress] : [])], {
    encoding: "base64", commitment: "finalized", minContextSlot: discovery.context.slot,
  }).send({ abortSignal: signal });
  if (typeof response.context.slot !== "bigint" || response.context.slot < discovery.context.slot || response.value.length !== (includeOrderBook ? 8 : 7)) {
    throw new Error("Invalid escrow final snapshot");
  }
  const [config, mint, marketAccount, seats, locator, vault, walletTokens] = response.value;
  const snapshot = await verifyGooseyEscrowSnapshot(runtime, input, market.seats,
    { config, mint, market: marketAccount, seats, locator, vault, walletTokens });
  // Use the very same finalized batch as token backing/issuance verification.
  // A later standalone book read could silently combine incompatible reserves.
  const orderBook = bookAddress ? await readCanonicalOrderBook({ programAddress: runtime.programAddress, marketId: input.marketId,
    market: { address: addresses.market, owner: runtime.programAddress, executable: false, data: raw(marketAccount, runtime.programAddress, 195) },
    seats: { address: market.seats, owner: runtime.programAddress, executable: false, data: raw(seats, runtime.programAddress, 32_816) },
    book: { address: bookAddress, owner: runtime.programAddress, executable: false,
      data: raw(response.value[7], runtime.programAddress, GOOSEY_ORDER_BOOK_BYTES) },
  }) : null;
  signal.throwIfAborted();
  return { ...snapshot, orderBook, finalizedSlot: response.context.slot };
}
