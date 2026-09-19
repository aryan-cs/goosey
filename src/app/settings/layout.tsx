import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings-nav";
import styles from "@/components/settings.module.css";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <div className={`page-shell ${styles.shell}`}><header className="page-header"><h1>Settings</h1><p>Make Goosey feel like you.</p></header><div className={styles.layout}><SettingsNav /><div className={styles.content}>{children}</div></div></div>;
}
