import { address } from "@solana/kit";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH, type SolanaRuntime } from "./runtime";

export type PublicBrowserRuntime = Readonly<{ version: 1; enabled: false }> | Readonly<{
  version: 1; enabled: true; cluster: SolanaRuntime["cluster"]; genesisHash: string;
  programAddress: SolanaRuntime["programAddress"]; publicRpcUrl: string;
  /** Configuration binding only; browser must probe its endpoint before use. */
  endpointVerified: false;
}>;
function fail(): never { throw new Error("Invalid public Solana runtime configuration"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function binding(cluster: unknown, genesis: unknown, program: unknown): Pick<SolanaRuntime, "cluster" | "genesisHash" | "programAddress"> {
  if (cluster !== "localnet" && cluster !== "devnet") return fail();
  if (typeof genesis !== "string" || typeof program !== "string") return fail();
  try { address(genesis); address(program); } catch { return fail(); }
  if (program === "11111111111111111111111111111111" || genesis === MAINNET_GENESIS_HASH || genesis === TESTNET_GENESIS_HASH
    || (cluster === "devnet" ? genesis !== DEVNET_GENESIS_HASH : genesis === DEVNET_GENESIS_HASH)) return fail();
  return { cluster, genesisHash: genesis, programAddress: address(program) };
}
function publicUrl(value: unknown, cluster: SolanaRuntime["cluster"]) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || value.trim() !== value
    || /[\s\\?#\u0000-\u001f\u007f]/u.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return fail();
  let url: URL;
  try { url = new URL(value); } catch { return fail(); }
  if (url.username || url.password || url.search || url.hash || /[*;]/.test(url.hostname)
    || !["http:", "https:"].includes(url.protocol)) return fail();
  if (cluster === "localnet" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return fail();
  if (cluster === "devnet" && url.protocol !== "https:") return fail();
  // Paths may contain operator-declared public routing identifiers. It is not
  // possible to determine whether an arbitrary path contains a secret. Setting
  // PUBLIC_RPC_URL explicitly authorizes publishing the entire path; never copy
  // a private provider URL/key here. Queries and credentials are always rejected.
  return url.toString();
}

/** Server-side projection, but pure/browser-safe: no process.env, fetch or RPC.
 * Caller supplies environment explicitly. NEVER reads runtime.rpcUrl, including
 * when public configuration is absent. No account/provider objects are spread.
 * Enabling this capability does not change the financial backend or authorize
 * signing, funding, grants, or trading. Endpoint probing remains mandatory.
 */
export function buildPublicBrowserRuntime(runtime: SolanaRuntime, env: Readonly<Record<string, string | undefined>>): PublicBrowserRuntime {
  const enabled = env.GOOSEY_SOLANA_BROWSER_ENABLED;
  if (enabled === undefined || enabled === "false") return Object.freeze({ version: 1, enabled: false });
  if (enabled !== "true") return fail();
  const chain = binding(runtime.cluster, runtime.genesisHash, runtime.programAddress);
  const publicRpcUrl = publicUrl(env.GOOSEY_SOLANA_PUBLIC_RPC_URL, chain.cluster);
  return Object.freeze({ version: 1, enabled: true, ...chain, publicRpcUrl, endpointVerified: false });
}

function integer(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return fail();
  const result = BigInt(value); if (result >= 1n << 64n) return fail(); return result;
}

/** Parse the same-origin public status JSON, NOT arbitrary user RPC settings.
 * null means the explicit browser capability is unavailable/disabled. Throws on
 * malformed or contradictory enabled payloads. The result is CONFIGURATION,
 * not endpoint verification: run probeSolanaRuntime/verified readers using this
 * returned public runtime before any wallet prompt. Server foundation_verified
 * pertains to the server's endpoint, not this potentially different endpoint.
 */
export function parsePublicBrowserRuntime(payload: unknown): SolanaRuntime | null {
  const status = record(payload);
  if (status.financialBackend !== "database" || status.exchangeVerified !== false
    || !["disabled", "unavailable", "foundation_verified"].includes(status.status as string)) return fail();
  if (status.browserRuntime === undefined) return null;
  const capability = record(status.browserRuntime);
  if (capability.version !== 1 || typeof capability.enabled !== "boolean") return fail();
  const allowed = capability.enabled ? ["version", "enabled", "cluster", "genesisHash", "programAddress", "publicRpcUrl", "endpointVerified"] : ["version", "enabled"];
  if (Object.keys(capability).some(key => !allowed.includes(key))) return fail();
  if (!capability.enabled) return null;
  if (status.status !== "foundation_verified" || capability.endpointVerified !== false) return fail();
  const chain = binding(capability.cluster, capability.genesisHash, capability.programAddress);
  if (status.cluster !== chain.cluster || status.genesisHash !== chain.genesisHash || status.programAddress !== chain.programAddress) return fail();
  const rpcUrl = publicUrl(capability.publicRpcUrl, chain.cluster);
  if (status.decimals !== 3 || typeof status.configAddress !== "string" || typeof status.featherMint !== "string") return fail();
  try { address(status.configAddress); address(status.featherMint); } catch { return fail(); }
  integer(status.finalizedSlot);
  const supply = integer(status.supplyBaseUnits), minted = integer(status.lifetimeMintedBaseUnits),
    authorized = integer(status.lifetimeAuthorizedBaseUnits), cap = integer(status.campaignCapBaseUnits);
  if (supply > minted || minted > authorized || authorized > cap || cap === 0n) return fail();
  if (typeof status.checkedAt !== "string" || status.checkedAt.length !== 24
    || !Number.isFinite(Date.parse(status.checkedAt)) || new Date(status.checkedAt).toISOString() !== status.checkedAt) return fail();
  const currency = record(status.currency);
  if (currency.name !== "feathers" || currency.purchasable !== false || currency.cashRedeemable !== false) return fail();
  return Object.freeze({ ...chain, rpcUrl });
}
