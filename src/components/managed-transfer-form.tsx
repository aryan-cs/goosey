"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useRef, useState } from "react";

import { FeatherIcon } from "@/components/brand";
import { apiFetch } from "@/lib/client-api";
import { formatFeathers } from "@/lib/feather-format";
import styles from "./managed-transfer-form.module.css";

type Attempt = Readonly<{ key: string; recipient: string; amount: string; body: string }>;
type Player = Readonly<{ userId: string; username: string; displayName: string }>;

export function normalizeTransferUsername(value: string) {
  return value.trim().replace(/^@/, "").normalize("NFKC").toLocaleLowerCase("en-CA");
}

export function validTransferAmount(value: string) {
  return /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(value) && Number(value) > 0;
}

async function exactRecipient(username: string): Promise<Player> {
  const response = await fetch(`/api/leaderboard/search?q=${encodeURIComponent(username)}&limit=8`, {
    credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({})) as { players?: Player[]; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "That username could not be checked.");
  const player = body.players?.find(item => normalizeTransferUsername(item.username) === username);
  if (!player) throw new Error(`No active Goosey user has the username @${username}.`);
  return player;
}

async function pollCommand(id: string): Promise<"finalized" | "unknown" | "failed"> {
  const deadline = Date.now() + 55_000;
  while (Date.now() < deadline) {
    const response = await fetch(`/api/v1/commands/${encodeURIComponent(id)}`, {
      credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" },
    });
    const body = await response.json().catch(() => ({})) as { status?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? "Transfer status is unavailable.");
    if (body.status === "FINALIZED" || body.status === "PROJECTED") return "finalized";
    if (body.status === "FAILED_TERMINAL") return "failed";
    if (body.status === "UNKNOWN") return "unknown";
    await new Promise(resolve => window.setTimeout(resolve, 1_000));
  }
  return "unknown";
}

export function ManagedTransferForm({ availableMilli }: { availableMilli: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const available = BigInt(availableMilli);

  function reset() { attempt.current = null; setMessage(null); setError(null); }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || available === 0n) return;
    const recipient = normalizeTransferUsername(username);
    if (!/^[a-z0-9](?:[a-z0-9_]{1,22}[a-z0-9])$/.test(recipient)) {
      setError("Enter a valid Goosey username."); return;
    }
    if (!validTransferAmount(amount)) {
      setError("Enter a positive feather amount with up to three decimal places."); return;
    }
    setBusy(true); setError(null); setMessage("Checking the recipient…");
    try {
      if (!attempt.current || attempt.current.recipient !== recipient || attempt.current.amount !== amount) {
        const player = await exactRecipient(recipient);
        attempt.current = { key: crypto.randomUUID(), recipient, amount,
          body: JSON.stringify({ recipientUserId: player.userId, amount }) };
      }
      setMessage(`Sending feathers to @${recipient}…`);
      const response = await apiFetch("/api/v1/transfers", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key }, body: attempt.current.body });
      const body = await response.json().catch(() => ({})) as { accepted?: boolean; pending?: boolean;
        command?: { id?: string }; error?: { message?: string } };
      if (!response.ok || body.accepted !== true || body.pending !== true || !body.command?.id) {
        throw new Error(body.error?.message ?? "The transfer could not be accepted.");
      }
      setMessage("Transfer accepted. Waiting for confirmation…");
      const outcome = await pollCommand(body.command.id);
      if (outcome === "failed") throw new Error("The transfer was rejected during final confirmation.");
      if (outcome === "unknown") {
        setMessage("Confirmation is taking longer than expected. The transfer is safely recorded and will not be duplicated.");
      } else {
        setMessage(`Sent feathers to @${recipient}.`);
        attempt.current = null; setAmount(""); router.refresh();
      }
    } catch (reason) {
      setMessage(null);
      setError(reason instanceof Error ? reason.message : "The transfer could not be completed.");
    } finally { setBusy(false); }
  }

  return <article className={styles.card} aria-labelledby="send-feathers-heading">
    <div className={styles.heading}><h3 id="send-feathers-heading">Send feathers</h3>
      <p>Send free play-money feathers to another Goosey user by username.</p></div>
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>Username<input value={username} onChange={event => { setUsername(event.currentTarget.value); reset(); }}
        placeholder="@username" autoComplete="off" spellCheck={false} disabled={busy} /></label>
      <label className={styles.field}>Amount<input value={amount} onChange={event => { setAmount(event.currentTarget.value); reset(); }}
        placeholder="25" type="number" inputMode="decimal" min="0.001" step="0.001" disabled={busy || available === 0n} /></label>
      <button className="button button-primary" type="submit" disabled={busy || available === 0n}>
        {busy && <LoaderCircle className="spin" aria-hidden="true" />}Send
      </button>
    </form>
    <p className={styles.available}><FeatherIcon /> {formatFeathers(available)} available</p>
    {message && <p className={styles.status} role="status">{message}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <p className={styles.policy}>Transfers stay within Goosey. Feathers have no cash value and cannot be redeemed for money or prizes.</p>
  </article>;
}
