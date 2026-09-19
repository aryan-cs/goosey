"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Proposal = {
  id: string;
  outcome: string;
  reason: string;
  evidence: string;
  proposer: { username: string; displayName: string };
  market: { title: string; slug: string; status: string };
};

type SettlementRun = {
  id: string;
  marketId: string;
  outcome: string;
  status: string;
  totalPositions: number;
  processedCount: number;
  totalPayoutMilli: string | bigint;
  batchCount: number;
  lastError: string | null;
  market: { title: string; slug: string };
};

function progress(run: SettlementRun): number {
  if (run.status === "COMPLETED") return 100;
  if (run.totalPositions === 0) return 0;
  return Math.min(100, Math.floor((run.processedCount / run.totalPositions) * 100));
}

async function requestFingerprint(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ResolutionQueue({
  initialProposals,
  initialRuns,
  viewerId,
  proposerIds,
}: {
  initialProposals: Proposal[];
  initialRuns: SettlementRun[];
  viewerId: string;
  proposerIds: Record<string, string>;
}) {
  const router = useRouter();
  const [proposals, setProposals] = useState(initialProposals);
  const [runs, setRuns] = useState(initialRuns);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [approvalPassword, setApprovalPassword] = useState("");
  const [sourceProps, setSourceProps] = useState({ initialProposals, initialRuns });
  const operationInFlight = useRef(false);
  const reviewAttempt = useRef<{ signature: string; key: string } | null>(null);

  // Next merges a refreshed Server Component payload without resetting this
  // Client Component's state. Adjust during render when refreshed props change
  // so the new queue is shown without an effect-driven extra stale render.
  if (sourceProps.initialProposals !== initialProposals || sourceProps.initialRuns !== initialRuns) {
    setSourceProps({ initialProposals, initialRuns });
    setProposals(initialProposals);
    setRuns(initialRuns);
  }

  async function review(id: string, action: "APPROVE" | "REJECT") {
    if (operationInFlight.current) return;
    if (proposerIds[id] === viewerId) {
      setError("A proposer cannot review their own resolution.");
      return;
    }
    const note = action === "REJECT" ? window.prompt("Explain why this proposal is rejected") : "";
    if (action === "REJECT" && (!note || note.trim().length < 3)) return;
    if (action === "APPROVE" && !approvalPassword) {
      setError("Re-enter your administrator password before approving settlement.");
      return;
    }
    operationInFlight.current = true;
    setBusyId(id);
    setError(null);
    try {
      const requestBody = JSON.stringify({
        action,
        note: note?.trim() ?? "",
        ...(action === "APPROVE" ? { password: approvalPassword } : {}),
      });
      const signature = `${id}:${await requestFingerprint(requestBody)}`;
      const idempotencyKey = reviewAttempt.current?.signature === signature
        ? reviewAttempt.current.key
        : crypto.randomUUID();
      reviewAttempt.current = { signature, key: idempotencyKey };
      const response = await fetch(`/api/admin/resolution-proposals/${id}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: requestBody,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status < 500 && reviewAttempt.current?.key === idempotencyKey) reviewAttempt.current = null;
        setError(body?.error?.message ?? "Resolution review failed.");
        return;
      }
      if (reviewAttempt.current?.key === idempotencyKey) reviewAttempt.current = null;
      setProposals((current) => current.filter((proposal) => proposal.id !== id));
      if (body.run) {
        const approved = initialProposals.find((proposal) => proposal.id === id);
        setRuns((current) => [
          { ...body.run, market: approved?.market ?? { title: "Approved market", slug: "" } },
          ...current.filter((run) => run.id !== body.run.id),
        ]);
      }
      setApprovalPassword("");
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : "Resolution review failed. Check your connection and retry.");
    } finally {
      // Reconcile after rejected or uncertain responses too: REJECT is not an
      // idempotent API, so a retry may report an already-reviewed proposal.
      router.refresh();
      operationInFlight.current = false;
      setBusyId(null);
    }
  }

  async function processRun(id: string) {
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setBusyId(id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/settlement-runs/${id}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchSize: 100 }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body?.error?.message ?? "Settlement batch failed. The run remains resumable.");
        return;
      }
      setRuns((current) => current.map((run) => (run.id === id ? { ...run, ...body.run } : run)));
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : "Settlement batch failed. Check your connection and retry.");
    } finally {
      // Processing advances the next batch rather than replaying the last one.
      // A lost response must not leave the operator looking at stale progress.
      router.refresh();
      operationInFlight.current = false;
      setBusyId(null);
    }
  }

  return (
    <section className="moderation-panel">
      <div className="section-heading">
        <div><span className="eyebrow">Two-person control</span><h2>Resolution approvals</h2></div>
        <span>{proposals.length} pending</span>
      </div>
      {error && <p className="form-error">{error}</p>}
      {proposals.length ? (
        <>
          <label className="stacked-form">
            Administrator password for approval
            <input type="password" autoComplete="current-password" value={approvalPassword} onChange={(event) => setApprovalPassword(event.target.value)} />
          </label>
          <div className="report-list">
            {proposals.map((proposal) => (
              <article className="report-item" key={proposal.id}>
                <header><strong>{proposal.outcome} · {proposal.market.title}</strong><span>proposed by @{proposal.proposer.username}</span></header>
                <p>{proposal.reason}</p>
                <small>Evidence: {proposal.evidence}</small>
                <footer>
                  <Link href={`/markets/${proposal.market.slug}`}>Review market</Link>
                  <button className="button button-ghost" disabled={busyId !== null || proposerIds[proposal.id] === viewerId} onClick={() => void review(proposal.id, "REJECT")}>Reject</button>
                  <button className="button button-secondary" disabled={busyId !== null || proposerIds[proposal.id] === viewerId} onClick={() => void review(proposal.id, "APPROVE")}>{busyId === proposal.id ? "Approving…" : "Approve outcome"}</button>
                </footer>
              </article>
            ))}
          </div>
        </>
      ) : <p className="muted-copy">No pending resolution proposals.</p>}

      <div className="section-heading">
        <div><span className="eyebrow">Durable workers</span><h2>Settlement runs</h2></div>
        <span>{runs.filter((run) => run.status !== "COMPLETED").length} active</span>
      </div>
      {runs.length ? (
        <div className="report-list">
          {runs.map((run) => (
            <article className="report-item" key={run.id}>
              <header><strong>{run.outcome} · {run.market.title}</strong><span>{run.status.toLowerCase()}</span></header>
              <p>{run.processedCount} of {run.totalPositions} positions · {progress(run)}% · {run.batchCount} bounded batch{run.batchCount === 1 ? "" : "es"}</p>
              {run.lastError && <small>Last worker error: {run.lastError}</small>}
              <footer>
                {run.market.slug && <Link href={`/markets/${run.market.slug}`}>View market</Link>}
                {run.status !== "COMPLETED" && (
                  <button className="button button-secondary" disabled={busyId !== null} onClick={() => void processRun(run.id)}>
                    {busyId === run.id ? "Processing…" : "Process next ≤100"}
                  </button>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : <p className="muted-copy">No settlement runs yet.</p>}
    </section>
  );
}
