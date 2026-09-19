import { LoadingState } from "@/components/states";

export default function Loading() {
  return <div className="page-shell" aria-live="polite"><LoadingState rows={6} label="Loading Goosey" /></div>;
}
