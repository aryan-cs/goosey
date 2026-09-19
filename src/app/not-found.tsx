import Link from "next/link";
import { EmptyState } from "@/components/states";

export default function NotFound() {
  return <div className="page-shell centered-state"><EmptyState title="Page not found" description="The link may be old, private, or no longer available." action={<Link className="button button-primary" href="/markets">Browse markets</Link>} /></div>;
}
