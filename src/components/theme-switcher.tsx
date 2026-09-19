"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { getServerThemePreference, getThemePreference, setThemePreference, subscribeToTheme, type ThemePreference } from "@/lib/theme";
import styles from "./theme-switcher.module.css";

const choices: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeSwitcher() {
  const id = useId();
  const theme = useSyncExternalStore(subscribeToTheme, getThemePreference, getServerThemePreference);
  const [saveFailed, setSaveFailed] = useState(false);

  function select(preference: ThemePreference) {
    setSaveFailed(!setThemePreference(preference));
  }

  return (
    <fieldset className={styles.fieldset} aria-describedby={`${id}-help ${id}-status`}>
      <legend className={styles.legend}>Theme</legend>
      <p id={`${id}-help`} className={styles.help}>Changes apply immediately.</p>
      <div className={styles.choices}>
        {choices.map(({ value, label }) => (
          <label key={value} className={styles.choice}>
            <input type="radio" name={`${id}-theme`} value={value} checked={theme === value} onChange={() => select(value)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <p id={`${id}-status`} role="status" className={saveFailed ? styles.error : styles.status}>
        {saveFailed ? "Theme changed, but your browser couldn't save it. It may reset when you reload." : "This setting applies to this browser."}
      </p>
    </fieldset>
  );
}
