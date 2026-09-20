import { CheckCircle2, Clock3, ShieldCheck } from "lucide-react";

import styles from "./market-settlement-status.module.css";

export type FinalizedSettlementAttestation = Readonly<{
  signature: string;
  slot: string;
}>;

export type MarketSettlementRecordState = "recorded" | "pending" | "unresolved";

function hasFinalizedAttestation(attestation: FinalizedSettlementAttestation | null | undefined): boolean {
  return Boolean(attestation?.signature.trim()) && /^(0|[1-9][0-9]*)$/.test(attestation?.slot ?? "");
}

export function marketSettlementRecordState(
  status: string,
  attestation?: FinalizedSettlementAttestation | null,
): MarketSettlementRecordState {
  if (hasFinalizedAttestation(attestation)) return "recorded";
  return status === "RESOLVED" || status === "VOID" ? "pending" : "unresolved";
}

export function MarketSettlementStatus({
  status,
  attestation,
}: Readonly<{
  status: string;
  attestation?: FinalizedSettlementAttestation | null;
}>) {
  const state = marketSettlementRecordState(status, attestation);
  const content = state === "recorded"
    ? {
        icon: <CheckCircle2 aria-hidden="true" />,
        title: "Recorded on Solana",
        detail: `Finalized settlement record at slot ${attestation!.slot}.`,
      }
    : state === "pending"
      ? {
          icon: <Clock3 aria-hidden="true" />,
          title: "Settlement record pending",
          detail: "This market is complete. Its Solana settlement record is still pending.",
        }
      : {
          icon: <ShieldCheck aria-hidden="true" />,
          title: "Settles on Solana",
          detail: "When this market is decided, Goosey records the settlement on Solana.",
        };

  return <aside className={`${styles.status} ${styles[state]}`} aria-label="Solana settlement status">
    {content.icon}
    <div>
      <strong>{content.title}</strong>
      <p>{content.detail} Feathers are free play money; no cryptocurrency moves through your account.</p>
    </div>
  </aside>;
}
