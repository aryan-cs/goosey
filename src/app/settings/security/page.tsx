import Link from "next/link";
import { getSettingsUser } from "@/lib/settings-session";
import { SessionManager } from "@/components/session-manager";
import { LogoutButton } from "@/components/logout-button";
import styles from "@/components/settings.module.css";
export default async function SecuritySettingsPage() {
  const user = await getSettingsUser("security");
  return <><section className={styles.panel}><h2>Account security</h2><dl className={styles.account}><dt>Email</dt><dd>{user.email}</dd></dl><h3>Password</h3><p>Get a password reset link by email. Changing your password signs you out everywhere.</p><Link className="button button-secondary" href="/reset-password?next=%2Fsettings%2Fsecurity">Reset password</Link></section><section className={styles.panel}><h3>Signed-in browsers</h3><p>See a browser you don’t recognize? Sign it out. This browser will stay signed in.</p><SessionManager /></section><section className={styles.panel}><h3>Sign out</h3><LogoutButton /></section></>;
}
