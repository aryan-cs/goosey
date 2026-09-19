"use client";

import Link from "next/link";
import { useState } from "react";

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
  const [proposals, setProposals] = useState(initialProposals);
  const [runs, setRuns] = useState(initialRuns);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [approvalPassword, setApprovalPassword] = useState("");

  async function review(id: string, action: "APPROVE" | "REJECT") {
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
    setBusyId(id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/resolution-proposals/${id}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          action,
          note: note?.trim() ?? "",
          ...(action === "APPROVE" ? { password: approvalPassword } : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body?.error?.message ?? "Resolution review failed.");
        return;
      }
      setProposals((current) => current.filter((proposal) => proposal.id !== id));
      if (body.run) {
        const approved = initialProposals.find((proposal) => proposal.id === id);
        setRuns((current) => [
          { ...body.run, market: approved?.market ?? { title: "Approved market", slug: "" } },
          ...current.filter((run) => run.id !== body.run.id),
        ]);
      }
      setApprovalPassword("");
    } finally {
      setBusyId(null);
    }
  }

  async function processRun(id: string) {
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
    } finally {
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
                  <button className="button button-ghost" disabled={busyId === proposal.id || proposerIds[proposal.id] === viewerId} onClick={() => void review(proposal.id, "REJECT")}>Reject</button>
                  <button className="button button-secondary" disabled={busyId === proposal.id || proposerIds[proposal.id] === viewerId} onClick={() => void review(proposal.id, "APPROVE")}>{busyId === proposal.id ? "Approving…" : "Approve outcome"}</button>
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
                  <button className="button button-secondary" disabled={busyId === run.id} onClick={() => void processRun(run.id)}>
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
