import path from "node:path";

import type { Address } from "@solana/kit";

import type { RetainedMarketTermsExpectation } from "./market-terms-store";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";

export type ReleaseReadinessState = "absent" | "unavailable" | "partial" | "ready";

type Gate<T extends object = object> = Readonly<{
  state: ReleaseReadinessState;
  reason: string;
} & T>;

type CatalogMarket = Readonly<{ marketId: string; marketAddress: Address }>;
type Configuration = Readonly<{
  config: Address;
  featherMint: Address;
  mintAuthority: Address;
  admin: Address;
  enrollmentAuthority: Address;
  decimals: 3;
  finalizedSlot: string;
}>;
type MarketSnapshot = Readonly<{
  market: Address;
  config: Address;
  featherMint: Address;
  creator: Address;
  payoutMilli: string;
  feeBps: string;
  closesAt: string;
  resolvesAt: string;
  finalizedSlot: string;
  terms: Readonly<{
    digest: string;
    manifestLength: number;
    sealed: boolean;
    acceptanceBits: number;
    proposer: Readonly<{ wallet: Address; enrollment: Address }>;
    approver: Readonly<{ wallet: Address; enrollment: Address }>;
  }> | null;
  hasOrderBook: boolean;
  hasResolution: boolean;
}>;
type IndexerStatus = Readonly<{
  worker: Readonly<{ state: "missing" | "stopped" | "stale" | "failing" | "running" }>;
  coverage: Readonly<{ status: "unavailable" | "partial" | "bounded_complete"; revision: number | null; fullHistory: false }>;
}>;

export type ReleaseReadinessDependencies = Readonly<{
  probe(runtime: SolanaRuntime, signal: AbortSignal): Promise<Readonly<{
    finalizedSlot: string;
    programExecutable: true;
  }>>;
  configuration(runtime: SolanaRuntime, signal: AbortSignal): Promise<Configuration>;
  catalog(runtime: SolanaRuntime): Promise<readonly CatalogMarket[]>;
  market(runtime: SolanaRuntime, marketId: bigint, signal: AbortSignal): Promise<MarketSnapshot>;
  retainedTerms(directory: string, expectation: RetainedMarketTermsExpectation): Promise<Readonly<{ digest: string }>>;
  indexer(runtime: SolanaRuntime): Promise<IndexerStatus>;
}>;

export type SolanaReleaseReadinessReport = Readonly<{
  version: 1;
  checkedAt: string;
  state: ReleaseReadinessState;
  ready: boolean;
  readOnly: true;
  deployment: Gate<{
    cluster: "localnet" | "devnet";
    genesisHash: string;
    programAddress: Address;
    finalizedSlot: string | null;
    executable: boolean;
  }>;
  configuration: Gate<{
    config: Address | null;
    featherMint: Address | null;
    mintAuthority: Address | null;
    admin: Address | null;
    enrollmentAuthority: Address | null;
    decimals: 3 | null;
    finalizedSlot: string | null;
  }>;
  markets: Gate<{
    requested: number;
    ready: number;
    items: readonly Readonly<{
      marketId: string;
      marketAddress: Address;
      state: ReleaseReadinessState;
      reason: string;
      finalizedSlot: string | null;
      termsDigest: string | null;
    }>[];
  }>;
  indexer: Gate<{
    worker: IndexerStatus["worker"]["state"] | null;
    coverage: IndexerStatus["coverage"]["status"] | null;
    revision: number | null;
    fullHistory: false;
  }>;
}>;

const unavailableConfiguration = {
  config: null, featherMint: null, mintAuthority: null, admin: null,
  enrollmentAuthority: null, decimals: null, finalizedSlot: null,
} as const;

function safeProbeFailure(error: unknown): Gate["state"] {
  if (error instanceof Error && error.message === "Configured Goosey program is not deployed and executable.") return "absent";
  if (error instanceof Error && (error.message === "Solana RPC genesis mismatch; refusing this network."
    || error.message === "Configured program does not use the expected Solana program loader.")) return "partial";
  return "unavailable";
}

function overallState(gates: readonly Readonly<{ state: ReleaseReadinessState }>[]): ReleaseReadinessState {
  if (gates.every(gate => gate.state === "ready")) return "ready";
  if (gates.every(gate => gate.state === "absent")) return "absent";
  if (!gates.some(gate => gate.state === "ready") && gates.some(gate => gate.state === "unavailable")) return "unavailable";
  return "partial";
}

function validTermsDirectory(value: string | undefined): value is string {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
    && value !== path.parse(value).root && !/[\u0000-\u001f\u007f]/u.test(value);
}

function blockedReport(runtime: SolanaRuntime, deployment: SolanaReleaseReadinessReport["deployment"], checkedAt: string) {
  const configuration = { state: "unavailable", reason: "deployment_not_ready", ...unavailableConfiguration } as const;
  const markets = { state: "unavailable", reason: "deployment_not_ready", requested: 0, ready: 0, items: [] } as const;
  const indexer = { state: "unavailable", reason: "deployment_not_ready", worker: null,
    coverage: null, revision: null, fullHistory: false } as const;
  const state = overallState([deployment, configuration, markets, indexer]);
  return { version: 1, checkedAt, state, ready: false, readOnly: true, deployment, configuration, markets, indexer } as const;
}

/** Read-only, fail-closed release evidence. Dependencies are injectable so tests
 * can exercise every external boundary without an RPC, database, or filesystem.
 * No dependency accepts a signer or exposes a transaction-submission method.
 */
export async function inspectSolanaReleaseReadiness(input: {
  runtime: SolanaRuntime;
  termsDirectory?: string;
  catalogEnabled: boolean;
  signal?: AbortSignal;
  now?: Date;
}, dependencies: ReleaseReadinessDependencies): Promise<SolanaReleaseReadinessReport> {
  const supplied = { ...input.runtime };
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: supplied.cluster,
    GOOSEY_SOLANA_RPC_URL: supplied.rpcUrl, GOOSEY_SOLANA_PROGRAM_ID: supplied.programAddress,
    GOOSEY_SOLANA_GENESIS_HASH: supplied.genesisHash });
  const checkedAt = (input.now ?? new Date()).toISOString();
  const signal = input.signal ?? AbortSignal.timeout(30_000);
  signal.throwIfAborted();

  let firstProbe: Awaited<ReturnType<ReleaseReadinessDependencies["probe"]>>;
  try { firstProbe = await dependencies.probe(runtime, signal); }
  catch (error) {
    const state = safeProbeFailure(error);
    const deployment = { state, reason: state === "absent" ? "program_absent" : state === "partial" ? "deployment_mismatch" : "rpc_unavailable",
      cluster: runtime.cluster, genesisHash: runtime.genesisHash, programAddress: runtime.programAddress,
      finalizedSlot: null, executable: false } as const;
    return blockedReport(runtime, deployment, checkedAt);
  }
  let deployment: SolanaReleaseReadinessReport["deployment"] = {
    state: "ready", reason: "verified", cluster: runtime.cluster, genesisHash: runtime.genesisHash,
    programAddress: runtime.programAddress, finalizedSlot: firstProbe.finalizedSlot, executable: true,
  };

  let configuration: SolanaReleaseReadinessReport["configuration"];
  try {
    const value = await dependencies.configuration(runtime, signal);
    configuration = { state: "ready", reason: "verified", ...value };
  } catch {
    configuration = { state: "partial", reason: "configuration_verification_failed", ...unavailableConfiguration };
  }

  let catalog: readonly CatalogMarket[] = [];
  let catalogFailed = false;
  try { catalog = await dependencies.catalog(runtime); }
  catch { catalogFailed = true; }
  const marketItems: SolanaReleaseReadinessReport["markets"]["items"][number][] = [];
  if (!catalogFailed) {
    const termsDirectory = input.termsDirectory;
    for (const listed of catalog) {
      let item: SolanaReleaseReadinessReport["markets"]["items"][number];
      try {
        const marketId = BigInt(listed.marketId);
        const snapshot = await dependencies.market(runtime, marketId, signal);
        const terms = snapshot.terms;
        if (snapshot.market !== listed.marketAddress || !terms || !terms.sealed || terms.acceptanceBits !== 3
          || !snapshot.hasOrderBook || !snapshot.hasResolution) {
          item = { marketId: listed.marketId, marketAddress: listed.marketAddress, state: "partial",
            reason: "chain_binding_or_terms_incomplete", finalizedSlot: snapshot.finalizedSlot,
            termsDigest: terms?.digest ?? null };
        } else if (!validTermsDirectory(termsDirectory)) {
          item = { marketId: listed.marketId, marketAddress: listed.marketAddress, state: "absent",
            reason: "retained_terms_directory_absent", finalizedSlot: snapshot.finalizedSlot, termsDigest: terms.digest };
        } else {
          const expectation: RetainedMarketTermsExpectation = {
            digest: terms.digest, manifestLength: terms.manifestLength,
            binding: { cluster: runtime.cluster, genesisHash: runtime.genesisHash, program: runtime.programAddress,
              config: snapshot.config, market: snapshot.market, marketId: listed.marketId,
              creator: snapshot.creator, featherMint: snapshot.featherMint },
            economics: { payoutMilli: snapshot.payoutMilli, feeBps: snapshot.feeBps,
              closesAt: snapshot.closesAt, resolvesAt: snapshot.resolvesAt, decimals: 3 },
            proposer: terms.proposer, approver: terms.approver,
          };
          try {
            const retained = await dependencies.retainedTerms(termsDirectory, expectation);
            item = { marketId: listed.marketId, marketAddress: listed.marketAddress,
              state: retained.digest === terms.digest ? "ready" : "partial",
              reason: retained.digest === terms.digest ? "verified" : "retained_terms_mismatch",
              finalizedSlot: snapshot.finalizedSlot, termsDigest: terms.digest };
          } catch (error) {
            const absent = !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
            item = { marketId: listed.marketId, marketAddress: listed.marketAddress,
              state: absent ? "absent" : "unavailable", reason: absent ? "retained_terms_absent" : "retained_terms_unavailable",
              finalizedSlot: snapshot.finalizedSlot, termsDigest: terms.digest };
          }
        }
      } catch {
        item = { marketId: listed.marketId, marketAddress: listed.marketAddress, state: "unavailable",
          reason: "chain_market_unavailable", finalizedSlot: null, termsDigest: null };
      }
      marketItems.push(item);
    }
  }
  const readyMarkets = marketItems.filter(item => item.state === "ready").length;
  let markets: SolanaReleaseReadinessReport["markets"];
  if (!input.catalogEnabled) markets = { state: "partial", reason: "catalog_disabled", requested: catalog.length,
    ready: readyMarkets, items: marketItems };
  else if (catalogFailed) markets = { state: "unavailable", reason: "catalog_unavailable", requested: 0, ready: 0, items: [] };
  else if (catalog.length === 0) markets = { state: "absent", reason: "no_published_markets", requested: 0, ready: 0, items: [] };
  else if (readyMarkets === catalog.length) markets = { state: "ready", reason: "verified", requested: catalog.length,
    ready: readyMarkets, items: marketItems };
  else if (marketItems.every(item => item.state === "unavailable")) markets = { state: "unavailable", reason: "all_markets_unavailable",
    requested: catalog.length, ready: 0, items: marketItems };
  else markets = { state: "partial", reason: "market_gates_incomplete", requested: catalog.length,
    ready: readyMarkets, items: marketItems };

  let indexer: SolanaReleaseReadinessReport["indexer"];
  try {
    const value = await dependencies.indexer(runtime);
    const isReady = value.worker.state === "running" && value.coverage.status === "bounded_complete";
    const isAbsent = value.worker.state === "missing" && value.coverage.status === "unavailable";
    indexer = { state: isReady ? "ready" : isAbsent ? "absent" : "partial",
      reason: isReady ? "verified" : isAbsent ? "indexer_absent" : "indexer_incomplete",
      worker: value.worker.state, coverage: value.coverage.status, revision: value.coverage.revision,
      fullHistory: false };
  } catch {
    indexer = { state: "unavailable", reason: "indexer_status_unavailable", worker: null,
      coverage: null, revision: null, fullHistory: false };
  }

  try {
    const closingProbe = await dependencies.probe(runtime, signal);
    if (!closingProbe.programExecutable || BigInt(closingProbe.finalizedSlot) < BigInt(firstProbe.finalizedSlot)) {
      deployment = { ...deployment, state: "partial", reason: "deployment_changed_during_check" };
    } else deployment = { ...deployment, finalizedSlot: closingProbe.finalizedSlot };
  } catch {
    deployment = { ...deployment, state: "unavailable", reason: "closing_probe_unavailable" };
  }
  signal.throwIfAborted();
  const state = overallState([deployment, configuration, markets, indexer]);
  return { version: 1, checkedAt, state, ready: state === "ready", readOnly: true,
    deployment, configuration, markets, indexer };
}
