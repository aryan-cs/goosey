import { ThemeSwitcher } from "@/components/theme-switcher";
import styles from "@/components/settings.module.css";
export default function AppearanceSettingsPage() {
  return <section className={styles.panel}><h2>Appearance</h2><p>Choose a look, or let Goosey follow your device.</p><ThemeSwitcher /></section>;
}
