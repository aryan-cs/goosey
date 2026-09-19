"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <div className="page-shell centered-state"><section className="error-state" role="alert"><AlertTriangle aria-hidden="true" /><div><h1>Oh…</h1><p>Something went wrong. We’re sorry about that, and we’re working to get things back to normal as soon as possible.</p></div><button className="button button-secondary" onClick={reset}>Try again</button></section></div>;
}
