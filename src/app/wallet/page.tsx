import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/states";
import { SolanaWallet } from "@/components/solana-wallet";
import { requiresEmailVerification } from "@/lib/auth";
import { getServerUser } from "@/lib/server-session";
import styles from "./wallet.module.css";

export const dynamic = "force-dynamic";

export default async function WalletPage() {
  const user = await getServerUser();
  if (!user) return <div className="page-shell centered-state"><EmptyState title="Your wallet" description="Sign in to connect your Solana wallet." action={<Link className="button button-primary" href="/login?next=%2Fwallet">Sign in</Link>} /></div>;
  if (requiresEmailVerification(user)) redirect("/verify-email?next=%2Fwallet");
  return <div className={`page-shell ${styles.page}`}><header className="page-header"><h1>Wallet</h1><Link className="section-link" href="/portfolio">Portfolio</Link></header><SolanaWallet /></div>;
}
