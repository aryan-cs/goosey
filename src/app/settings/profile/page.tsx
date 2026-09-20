import Link from "next/link";
import { ProfileForm } from "@/components/profile-form";
import { db } from "@/lib/db";
import { getSettingsUser } from "@/lib/settings-session";
import styles from "@/components/settings.module.css";

export default async function ProfileSettingsPage() {
  const user = await getSettingsUser("profile");
  const profile = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { username: true, bio: true, profilePublic: true } });
  return <><section className={styles.panel}><h2>Profile</h2><p>Your username appears with your trades, comments, and leaderboard ranking.</p><ProfileForm profile={profile} /></section><section className={styles.panel}><h3>Your activity</h3><div className={styles.links}><Link href="/portfolio">Portfolio</Link><Link href="/watchlist">Watchlist</Link><Link href={`/users/${encodeURIComponent(profile.username)}`}>View trading profile</Link></div></section></>;
}
