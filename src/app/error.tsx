"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <div className="page-shell centered-state"><section className="error-state"><AlertTriangle /><div><strong>This page did not load</strong><p>If you just placed a trade, check your portfolio before trying again.</p></div><button className="button button-secondary" onClick={reset}>Try again</button></section></div>;
}
