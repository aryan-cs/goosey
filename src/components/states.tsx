import type { ReactNode } from "react";
import { AlertCircle, Feather, RefreshCw } from "lucide-react";

export function LoadingState({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return <div className="loading-state" role="status" aria-label={label}>{Array.from({ length: rows }, (_, i) => <div className="skeleton-row" key={i} />)}<span className="sr-only">{label}</span></div>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Feather /></span><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error-state" role="alert"><AlertCircle /><div><strong>Could not load this</strong><p>{message}</p></div>{onRetry && <button className="button button-secondary" onClick={onRetry}><RefreshCw /> Retry</button>}</div>;
}
