import Link from "next/link";
import { getServerUser } from "@/lib/server-session";
import { db } from "@/lib/db";
import { requiresEmailVerification } from "@/lib/auth";
import { ProfileForm } from "@/components/profile-form";
import styles from "@/components/settings.module.css";
export default async function PrivacySettingsPage() {
  const user = await getServerUser();
  const profile = user && !requiresEmailVerification(user) ? await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { username: true, bio: true, profilePublic: true, leaderboardVisible: true } }) : null;
  return <><section className={styles.panel}><h2>Privacy</h2>{profile ? <ProfileForm profile={profile} privacyOnly /> : <Link className="button button-secondary" href={user ? "/verify-email?next=%2Fsettings%2Fprivacy" : "/login?next=%2Fsettings%2Fprivacy"}>{user ? "Verify email to manage privacy" : "Sign in to manage privacy"}</Link>}</section><section className={styles.panel}><h3>What other people can see</h3><p>Your market comments and replies show your username, even when your profile is private. A public profile also identifies you in recent trading activity. Leaderboard visibility is a separate choice.</p><h3>What stays private</h3><p>Your email, balance, full trade history, password, and signed-in browsers are private.</p><h3>Play money only</h3><p>Feathers have no cash value and cannot be transferred outside Goosey.</p><div className={styles.links}><Link href="/rules">Community rules and market policies</Link></div></section></>;
}
