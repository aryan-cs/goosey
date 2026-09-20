import Link from "next/link";
import { getSettingsUser } from "@/lib/settings-session";
import { SessionManager } from "@/components/session-manager";
import { LogoutButton } from "@/components/logout-button";
import styles from "@/components/settings.module.css";
export default async function SecuritySettingsPage() {
  const user = await getSettingsUser("security");
  return <><section className={styles.panel}><h2>Account security</h2><dl className={styles.account}><dt>Primary account email</dt><dd>{user.email}</dd></dl><p>This must be an address you control and monitor. Goosey uses it for verification, account recovery, required notices, and to contact you about any prize or payment for which you qualify. If it is no longer accurate or accessible, <a href="https://forms.gle/uJVou9X5Gfppeuk67" target="_blank" rel="noreferrer">request account assistance</a>.</p><h3>Password</h3><p>Get a password reset link by email. Changing your password signs you out everywhere.</p><Link className="button button-secondary" href="/reset-password?next=%2Fsettings%2Fsecurity">Reset password</Link></section><section className={styles.panel}><h3>Linked badges</h3><p>Connect a badge or revoke its trading access.</p><Link href="/badge" className="button button-secondary">Manage badges</Link></section><section className={styles.panel}><h3>Signed-in browsers</h3><p>See a browser you don’t recognize? Sign it out. This browser will stay signed in.</p><SessionManager /></section><section className={styles.panel}><h3>Sign out</h3><LogoutButton /></section></>;
}
