"use client";

import { FormEvent, useRef, useState } from "react";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client-api";

function requestId(): string {
  return crypto.randomUUID();
}

function formatMilli(value: bigint): string {
  const whole = value / 1_000n;
  const fraction = (value % 1_000n).toString().padStart(3, "0");
  return `${whole}.${fraction}`;
}

export function RedemptionForm({
  marketSlug,
  marketVersion,
  maxQuantity,
  payoutMilli,
}: {
  marketSlug: string;
  marketVersion: number;
  maxQuantity: number;
  payoutMilli: string;
}) {
  const router = useRouter();
  const [quantity, setQuantity] = useState(maxQuantity);
  const [state, setState] = useState<"idle" | "submitting" | "success">("idle");
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(requestId());
  const payout = BigInt(quantity > 0 ? quantity : 0) * BigInt(payoutMilli);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity) {
      setError(`Enter a whole number from 1 to ${maxQuantity}.`);
      return;
    }
    setState("submitting");
    setError(null);
    try {
      const response = await apiFetch(`/api/markets/${encodeURIComponent(marketSlug)}/redeem`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({ quantity, marketVersion }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "These matching contracts could not be cashed out.");
      }
      setState("success");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "These matching contracts could not be cashed out.");
      setState("idle");
    }
  }

  if (state === "success") {
    return (
      <div className="success-message" role="status">
        <CheckCircle2 size={16} /> Cashed out. Your balance and positions are up to date.
      </div>
    );
  }

  return (
    <form className="stacked-form" onSubmit={submit}>
      <label>
        Cash out matching YES + NO contracts
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={maxQuantity}
          step={1}
          value={quantity}
          disabled={state === "submitting"}
          onChange={(event) => {
            setQuantity(event.currentTarget.valueAsNumber || 0);
            idempotencyKey.current = requestId();
            setError(null);
          }}
        />
      </label>
      <p className="muted-copy">
        Guaranteed payout: {formatMilli(payout)} feathers. You can cash out one matching YES and NO contract together.
      </p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="button button-secondary" disabled={state === "submitting"} type="submit">
        {state === "submitting" ? <LoaderCircle className="spin" /> : null}
        Cash out
      </button>
    </form>
  );
}
