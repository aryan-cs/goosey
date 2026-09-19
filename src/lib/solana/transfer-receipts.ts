import { address, getBase64Encoder, getBase64EncodedWireTransaction, getPublicKeyFromAddress,
  getSignatureFromTransaction, getTransactionDecoder, signature, verifySignature } from "@solana/kit";
import type { TransferSubmission } from "./submit-transfer";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH, type SolanaRuntime } from "./runtime";

type Receipt = Omit<TransferSubmission, "status">;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "key" | "length">;
type Domain = Pick<SolanaRuntime, "cluster" | "genesisHash" | "programAddress"> & { walletAddress: string };

/** Immutable write-before-send journal. One key per signature avoids whole-list
 * lost updates between tabs. Stores no private keys or sessions. This is local
 * recovery evidence, NOT proof of settlement, and it never sends transactions.
 * Storage denial/quota/corruption fails closed; never evict uncertain receipts
 * automatically to make room for a newly signed transfer.
 */
export function createTransferReceiptStore(storage: StoragePort, domain: Domain) {
  const context = { ...domain };
  address(context.programAddress); address(context.walletAddress);
  if (!["localnet", "devnet"].includes(context.cluster)
    || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(context.genesisHash)
    || context.genesisHash === MAINNET_GENESIS_HASH || context.genesisHash === TESTNET_GENESIS_HASH
    || (context.cluster === "devnet" && context.genesisHash !== DEVNET_GENESIS_HASH)
    || (context.cluster === "localnet" && context.genesisHash === DEVNET_GENESIS_HASH)) {
    throw new Error("Invalid receipt network domain");
  }
  try { address(context.genesisHash); }
  catch { throw new Error("Invalid receipt network domain: genesis must be 32 bytes"); }
  const prefix = `goosey:transfer:v1:${context.cluster}:${context.genesisHash}:${context.programAddress}:${context.walletAddress}:`;
  async function validate(receipt: Receipt) {
    signature(receipt.signature);
    if (typeof receipt.lastValidBlockHeight !== "bigint" || receipt.lastValidBlockHeight < 0n || receipt.lastValidBlockHeight > (1n << 64n) - 1n
      || typeof receipt.signedWireBase64 !== "string" || receipt.signedWireBase64.length > 1644
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(receipt.signedWireBase64)) {
      throw new Error("Invalid transfer recovery receipt");
    }
    const bytes = getBase64Encoder().encode(receipt.signedWireBase64);
    if (bytes.length > 1232) throw new Error("Oversized signed transaction");
    const transaction = getTransactionDecoder().decode(bytes);
    const signers = Object.keys(transaction.signatures);
    const wallet = address(context.walletAddress), walletSignature = transaction.signatures[wallet];
    if (signers.length !== 1 || signers[0] !== wallet || !walletSignature
      || getSignatureFromTransaction(transaction) !== receipt.signature
      || getBase64EncodedWireTransaction(transaction) !== receipt.signedWireBase64
      || !await verifySignature(await getPublicKeyFromAddress(wallet), walletSignature, transaction.messageBytes)) {
      throw new Error("Receipt does not contain this wallet's authentic signed transaction");
    }
    return Object.freeze({ signature: receipt.signature, signedWireBase64: receipt.signedWireBase64, lastValidBlockHeight: receipt.lastValidBlockHeight });
  }
  function parse(text: string): Receipt {
    if (text.length > 2200) throw new Error("Oversized recovery record");
    const data = JSON.parse(text) as Record<string, unknown>;
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).sort().join(",") !== "lastValidBlockHeight,signature,signedWireBase64,version"
      || data.version !== 1 || typeof data.signature !== "string" || typeof data.signedWireBase64 !== "string"
      || typeof data.lastValidBlockHeight !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(data.lastValidBlockHeight)) {
      throw new Error("Unsupported recovery record");
    }
    return { signature: data.signature, signedWireBase64: data.signedWireBase64, lastValidBlockHeight: BigInt(data.lastValidBlockHeight) };
  }
  return {
    async persist(receipt: Receipt) {
      // Snapshot the caller object before any await.
      const verified = await validate({ ...receipt });
      const key = prefix + verified.signature;
      const encoded = JSON.stringify({ version: 1, ...verified, lastValidBlockHeight: verified.lastValidBlockHeight.toString() });
      const previous = storage.getItem(key);
      if (previous !== null && previous !== encoded) throw new Error("Conflicting transfer recovery record; refusing overwrite");
      storage.setItem(key, encoded);
      if (storage.getItem(key) !== encoded) throw new Error("Transfer recovery receipt was not retained");
    },
    async list() {
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      const receipts: Receipt[] = [], unreadableKeys: string[] = [];
      for (const key of keys.sort()) {
        try {
          const text = storage.getItem(key);
          if (text === null) throw new Error("Receipt disappeared");
          const receipt = await validate(parse(text));
          if (key !== prefix + receipt.signature) throw new Error("Signature key mismatch");
          receipts.push(receipt);
        } catch { unreadableKeys.push(key); }
      }
      return { receipts, unreadableKeys };
    },
  };
}
