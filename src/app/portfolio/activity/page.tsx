import Link from "next/link";
import { redirect } from "next/navigation";
import { PortfolioActivity } from "@/components/portfolio-activity";
import { getServerUser } from "@/lib/server-session";
import { requiresEmailVerification } from "@/lib/auth";
import styles from "@/components/portfolio-activity.module.css";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const user = await getServerUser();
  if (!user) redirect("/login?next=%2Fportfolio%2Factivity");
  if (requiresEmailVerification(user)) redirect("/verify-email?next=%2Fportfolio%2Factivity");
  return <div className={`page-shell ${styles.page}`}><Link className="section-link" href="/portfolio">Back to portfolio</Link><header className="page-header"><span className="eyebrow">Your account</span><h1>Orders and fills</h1><p>See what you bought, sold, and still have waiting.</p></header><PortfolioActivity /></div>;
}
