import Link from "next/link";
import { redirect } from "next/navigation";
import { NotificationCenter } from "@/components/notification-center";
import { EmptyState } from "@/components/states";
import { getServerUser } from "@/lib/server-session";
import { requiresEmailVerification } from "@/lib/auth";

export default async function NotificationsPage() {
  const user = await getServerUser();
  if (!user) return <div className="page-shell centered-state"><EmptyState title="Sign in to see notifications" description="Your notifications are only visible to you." action={<Link className="button button-primary" href="/login">Sign in</Link>} /></div>;
  if (requiresEmailVerification(user)) redirect("/verify-email?next=%2Fnotifications");
  return <div className="page-shell notifications-page"><header className="page-header"><h1>Notifications</h1><p>Trade confirmations, market results, and replies.</p></header><NotificationCenter /></div>;
}
