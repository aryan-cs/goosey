import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";

export const RESOLUTION_STATE_BYTES = 268;
const ZERO = "11111111111111111111111111111111";
export type ResolutionMarketBinding = { market: Address; config: Address; creator: Address;
  payoutMilli: bigint; closesAt: bigint; resolvesAt: bigint };

/** Strict Borsh decoding of the canonical resolution account. This does not
 * establish finality, proposal evidence, outcome truth or token-vault backing.
 * Fetch alongside market/seats/book in the same finalized RPC batch.
 */
export async function readResolutionState(program: Address, binding: ResolutionMarketBinding, account: {
  address: Address; owner: Address; executable: boolean; data: Uint8Array;
}) {
  const programAddress = address(program), expected = { ...binding };
  const accountAddress = address(account.address);
  if (account.owner !== programAddress || account.executable !== false || !(account.data instanceof Uint8Array)
    || account.data.length !== RESOLUTION_STATE_BYTES) throw new Error("Invalid resolution account envelope");
  const bytes = new Uint8Array(account.data), view = new DataView(bytes.buffer);
  const [canonical] = await getProgramDerivedAddress({ programAddress,
    seeds: ["resolution", getAddressEncoder().encode(address(expected.market))] });
  if (accountAddress !== canonical) throw new Error("Noncanonical resolution PDA");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("account:ResolutionState")));
  if (!bytes.subarray(0, 8).every((n, i) => n === hash[i])) throw new Error("Invalid resolution discriminator");
  let offset = 8;
  const key = () => { const value = getAddressDecoder().decode(bytes.subarray(offset, offset + 32)); offset += 32; return value; };
  const u64 = () => { const value = view.getBigUint64(offset, true); offset += 8; return value; };
  const i64 = () => { const value = view.getBigInt64(offset, true); offset += 8; return value; };
  const option = <T>(read: () => T) => {
    const tag = bytes[offset++];
    if (tag === 0) return null;
    if (tag !== 1) throw new Error("Invalid resolution option tag");
    return read();
  };
  const market = key(), creator = key(), payoutMilli = u64(), closesAt = i64(), resolvesAt = i64();
  const proposer = { wallet: key(), enrollment: key() }, approver = { wallet: key(), enrollment: key() };
  const phase = bytes[offset++], nextProposalSequence = u64();
  const activeProposalSequence = option(u64), outcome = option(() => bytes[offset++]);
  const outstandingYes = u64(), outstandingNo = u64(), claimsProcessed = u64();
  // Anchor serializes variable-length Option fields into a max-sized account.
  // Unused tail bytes can retain older serialization; they are not live fields.
  if (market !== expected.market || creator !== expected.creator || payoutMilli !== expected.payoutMilli
    || closesAt !== expected.closesAt || resolvesAt !== expected.resolvesAt || creator === ZERO
    || payoutMilli < 2n || payoutMilli > 1_000_000n || closesAt <= 0n || resolvesAt < closesAt) throw new Error("Resolution market binding mismatch");
  if (phase > 4 || nextProposalSequence === 0n || (phase === 0 && nextProposalSequence !== 1n)
    || (phase >= 3 && nextProposalSequence < 2n) || (outcome !== null && outcome > 2)
    || (activeProposalSequence !== null && (activeProposalSequence === 0n || activeProposalSequence >= nextProposalSequence))) throw new Error("Invalid resolution phase/sequence");
  if ((phase === 2) !== (activeProposalSequence !== null) || (phase >= 3) !== (outcome !== null)
    || (phase < 3 && claimsProcessed !== 0n) || (phase === 0 && (outstandingYes !== 0n || outstandingNo !== 0n))
    || ((phase === 1 || phase === 2) && outstandingYes !== outstandingNo)
    || (phase === 4 && (outstandingYes !== 0n || outstandingNo !== 0n))) throw new Error("Inconsistent resolution lifecycle");
  if (proposer.wallet === ZERO || approver.wallet === ZERO || proposer.wallet === approver.wallet
    || proposer.wallet === creator || approver.wallet === creator || proposer.enrollment === approver.enrollment) throw new Error("Conflicting resolution reviewers");
  for (const reviewer of [proposer, approver]) {
    const [enrollment] = await getProgramDerivedAddress({ programAddress,
      seeds: ["enrollment", getAddressEncoder().encode(address(expected.config)), getAddressEncoder().encode(reviewer.wallet)] });
    if (reviewer.enrollment !== enrollment) throw new Error("Noncanonical reviewer enrollment");
  }
  return { address: canonical, market, creator, payoutMilli, closesAt, resolvesAt, proposer, approver,
    phase, nextProposalSequence, activeProposalSequence, outcome, outstandingYes, outstandingNo, claimsProcessed };
}
