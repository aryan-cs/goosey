import Link from "next/link";
import { getSettingsUser } from "@/lib/settings-session";
import { NotificationPreferences } from "@/components/notification-preferences";
import styles from "@/components/settings.module.css";
export default async function NotificationSettingsPage() {
  await getSettingsUser("notifications");
  return <section className={styles.panel}><h2>Notifications</h2><NotificationPreferences /><div className={styles.links}><Link href="/notifications">Open notifications</Link></div></section>;
}
