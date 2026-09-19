import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/server-session";
import { EmptyState } from "@/components/states";
import { ProfileForm } from "@/components/profile-form";
import { db } from "@/lib/db";
import { SessionManager } from "@/components/session-manager";
import { requiresEmailVerification } from "@/lib/auth";

export default async function ProfileSettingsPage() {
  const user = await getServerUser();
  if (!user) return <div className="page-shell centered-state"><EmptyState title="Sign in to manage your account" description="Profile and session settings are private." action={<Link className="button button-primary" href="/login">Sign in</Link>} /></div>;
  if (requiresEmailVerification(user)) redirect("/verify-email?next=%2Fsettings%2Fprofile");
  const profile = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { displayName: true, bio: true, profilePublic: true, leaderboardVisible: true } });
  return <div className="page-shell reading-page"><header className="page-header"><span className="eyebrow">Account</span><h1>{user.displayName}</h1><p>@{user.username} · {user.email}</p></header><section><h2>Profile and visibility</h2><ProfileForm profile={profile} /></section><section><h2>Saved markets</h2><p>Your watchlist is private.</p><Link href="/watchlist">View watchlist</Link></section><section><h2>Signed-in devices</h2><p>Review the browsers signed in to your account and remove any you do not recognize.</p><SessionManager /><form action="/api/auth/logout" method="post"><button className="button button-secondary">Sign out</button></form></section><section><h2>Privacy</h2><p>Your email, balance, and full trade history stay private. You choose whether your profile is public.</p><Link href="/settings/privacy">Privacy settings</Link></section></div>;
}
