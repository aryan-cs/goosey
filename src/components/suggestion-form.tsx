"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import { MARKET_CATEGORIES } from "@/lib/market-categories";
import { apiFetch } from "@/lib/client-api";

export function SuggestionForm() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setState("sending"); setError(null);
    const formElement = event.currentTarget;
    const data = new FormData(formElement);
    try {
      const response = await apiFetch("/api/suggestions", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: data.get("title"), description: data.get("description"), category: data.get("category") }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? "Suggestion could not be sent.");
      formElement.reset(); setState("sent"); router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Suggestion could not be sent."); setState("idle"); }
  }
  if (state === "sent") return <div className="success-panel" role="status"><CheckCircle2 /><h2>Suggestion sent</h2><p>We will review the question and how it should be decided.</p><button type="button" className="button button-secondary" onClick={() => setState("idle")}>Suggest another</button></div>;
  return <form className="stacked-form" onSubmit={submit}><label>What should people predict?<input name="title" minLength={12} maxLength={180} required placeholder="Will...?" /></label><label>Category<select name="category" required defaultValue=""><option value="" disabled>Choose a category</option>{MARKET_CATEGORIES.filter((category) => category !== "Trending").map((category) => <option value={category} key={category}>{category}</option>)}</select></label><label>How should this be decided?<textarea name="description" minLength={30} maxLength={2000} rows={7} required placeholder="What counts as YES? When does it close, and where can we check the result?" /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button button-primary" disabled={state === "sending"}>{state === "sending" && <LoaderCircle className="spin" />}Send suggestion</button></form>;
}
