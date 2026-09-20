import Link from "next/link";
import { getServerUser } from "@/lib/server-session";
import { db } from "@/lib/db";
import { requiresEmailVerification } from "@/lib/auth";
import { ProfileForm } from "@/components/profile-form";
import styles from "@/components/settings.module.css";
export default async function PrivacySettingsPage() {
  const user = await getServerUser();
  const profile = user && !requiresEmailVerification(user) ? await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { username: true, bio: true, profilePublic: true } }) : null;
  return <><section className={styles.panel}><h2>Privacy</h2>{profile ? <ProfileForm profile={profile} privacyOnly /> : <Link className="button button-secondary" href={user ? "/verify-email?next=%2Fsettings%2Fprivacy" : "/login?next=%2Fsettings%2Fprivacy"}>{user ? "Verify email to manage privacy" : "Sign in to manage privacy"}</Link>}</section><section className={styles.panel}><h3>What other people can see</h3><p>Your trading profile, trades, positions, market comments, replies, username, and leaderboard ranking are public. This cannot be turned off.</p><h3>What stays nonpublic</h3><p>Your email, password, signed-in browsers, and linked devices are not displayed publicly. Goosey uses your email for verification, account recovery, required notices, and any eligible prize or payment administration, and may disclose it to service providers for those purposes as described in the Privacy Notice. You can also hide your bio and remove your account from people search above.</p><h3>Play money only</h3><p>Feathers are free play money with no cash value. You can send them to another Goosey user by username, but they cannot be redeemed for money or prizes.</p><div className={styles.links}><Link href="/privacy">Privacy Notice</Link><Link href="/terms">Terms of Use</Link><Link href="/rules">Community rules and market policies</Link></div></section></>;
}
