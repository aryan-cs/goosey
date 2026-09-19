import Link from "next/link";
import { getSettingsUser } from "@/lib/settings-session";
import { SessionManager } from "@/components/session-manager";
import { LogoutButton } from "@/components/logout-button";
import styles from "@/components/settings.module.css";
export default async function SecuritySettingsPage() {
  const user = await getSettingsUser("security");
  return <><section className={styles.panel}><h2>Account security</h2><p>Keep your account and signed-in browsers under control.</p><dl className={styles.account}><dt>Email</dt><dd>{user.email}</dd><dt>Status</dt><dd>Verified</dd></dl><h3>Password</h3><p>Request a secure reset link by email. Resetting your password signs out your existing sessions.</p><Link className="button button-secondary" href="/reset-password?next=%2Fsettings%2Fsecurity">Reset password</Link></section><section className={styles.panel}><h3>Signed-in browsers</h3><p>Remove any browser you do not recognize. Signing out other browsers keeps this one signed in.</p><SessionManager /></section><section className={styles.panel}><h3>Sign out</h3><p>End your session on this browser.</p><LogoutButton /></section></>;
}
