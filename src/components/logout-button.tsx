"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("Sign out failed.");
      router.push("/");
      router.refresh();
    } catch {
      setError("We could not sign you out. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="stacked-form">
      <button className="button button-secondary" type="button" onClick={logout} disabled={submitting}>
        {submitting ? "Signing out…" : "Sign out"}
      </button>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
  );
}
