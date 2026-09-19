import Link from "next/link";
import { ProfileForm } from "@/components/profile-form";
import { db } from "@/lib/db";
import { getSettingsUser } from "@/lib/settings-session";
import styles from "@/components/settings.module.css";

export default async function ProfileSettingsPage() {
  const user = await getSettingsUser("profile");
  const profile = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { username: true, bio: true, profilePublic: true, leaderboardVisible: true } });
  return <><section className={styles.panel}><h2>Profile</h2><p>Your username appears with your comments and any activity you make public.</p><ProfileForm profile={profile} /></section><section className={styles.panel}><h3>Your activity</h3><div className={styles.links}><Link href="/portfolio">Portfolio</Link><Link href="/watchlist">Watchlist</Link>{profile.profilePublic && <Link href={`/users/${profile.username}`}>View public profile</Link>}</div></section></>;
}
