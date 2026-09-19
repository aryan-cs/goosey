import { type Address, type TransactionSigner } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

export const FEATHER_DECIMALS = 3;
export const MAX_TOKEN_BASE_UNITS = (1n << 64n) - 1n;

/** Parse display feathers without ever routing token amounts through Number. */
export function parseFeatherAmount(input: string): bigint {
  if (!/^(0|[1-9][0-9]{0,16})(\.[0-9]{1,3})?$/.test(input)) {
    throw new Error("Enter a positive feather amount with at most three decimal places.");
  }
  const [whole, fractional = ""] = input.split(".");
  const amount = BigInt(whole!) * 1_000n + BigInt(fractional.padEnd(3, "0"));
  if (amount === 0n || amount > MAX_TOKEN_BASE_UNITS) throw new Error("Feather amount is outside the supported token range.");
  return amount;
}

/** Build only. The wallet must approve/sign and the caller must confirm on the
 * pinned network. Nothing here debits a database balance or invents a receipt.
 * Mint comes from validated program configuration, never a recipient's input.
 */
export async function buildFeatherTransfer(input: {
  mint: Address;
  sender: TransactionSigner;
  recipient: Address;
  payer?: TransactionSigner;
  amount: bigint;
}) {
  if (typeof input.amount !== "bigint" || input.amount <= 0n || input.amount > MAX_TOKEN_BASE_UNITS) {
    throw new Error("Transfer amount must be a positive u64 in feather base units.");
  }
  if (input.sender.address === input.recipient) throw new Error("Choose a different recipient wallet.");
  const [source] = await findAssociatedTokenPda({ mint: input.mint, owner: input.sender.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [destination] = await findAssociatedTokenPda({ mint: input.mint, owner: input.recipient, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const payer = input.payer ?? input.sender;
  return {
    source,
    destination,
    amount: input.amount,
    instructions: [
      getCreateAssociatedTokenIdempotentInstruction({
        payer, ata: destination, mint: input.mint, owner: input.recipient, tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
      getTransferCheckedInstruction({
        source, destination, mint: input.mint, authority: input.sender,
        amount: input.amount, decimals: FEATHER_DECIMALS,
      }),
    ] as const,
  };
}
