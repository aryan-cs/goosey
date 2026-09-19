type CycleFailures = {
  orderExpirationFailures: number;
  marketCloseFailures: number;
  failedRuns: number;
};

/** One-shot invocations must fail for every persisted operation failure. */
export function settlementWorkerCycleFailed(result: CycleFailures): boolean {
  return result.orderExpirationFailures > 0 || result.marketCloseFailures > 0 || result.failedRuns > 0;
}
