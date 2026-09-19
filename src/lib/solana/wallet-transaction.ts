import type { Address, TransactionMessage, TransactionMessageWithBlockhashLifetime,
  TransactionMessageWithFeePayerSigner } from "@solana/kit";

/** Shared, unsigned wallet approval contract for transfers and program orders.
 * Economic intent comes from the preparation function; signing/submission must
 * preserve this exact message, wallet, network and embedded signing lifetime. */
export type PreparedWalletTransaction = {
  message: TransactionMessage & TransactionMessageWithBlockhashLifetime & TransactionMessageWithFeePayerSigner & { readonly version: 0 };
  sender: Address;
  cluster: "localnet" | "devnet";
  genesisHash: string;
};
