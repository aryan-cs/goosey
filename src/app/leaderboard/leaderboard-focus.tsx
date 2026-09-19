"use client";

import { useEffect } from "react";
import styles from "./leaderboard.module.css";

export function centerLeaderboardTarget(target: HTMLElement, reduceMotion: boolean) {
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center", inline: "nearest" });
  target.focus({ preventScroll: true });
  target.classList.remove(styles.highlighted);
  void target.offsetWidth;
  target.classList.add(styles.highlighted);
}

export function LeaderboardFocus({ focusKey }: { focusKey: string }) {
  useEffect(() => {
    let highlightTimer = 0;
    let frame = 0;

    const locate = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id.startsWith("player-")) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const target = document.getElementById(id);
        if (!target) return;
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        centerLeaderboardTarget(target, reduceMotion);
        window.clearTimeout(highlightTimer);
        highlightTimer = window.setTimeout(() => target.classList.remove(styles.highlighted), 1_800);
      });
    };

    const locateAfterClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-leaderboard-locate]")) return;
      window.setTimeout(locate, 0);
    };

    locate();
    window.addEventListener("hashchange", locate);
    document.addEventListener("click", locateAfterClick);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(highlightTimer);
      window.removeEventListener("hashchange", locate);
      document.removeEventListener("click", locateAfterClick);
    };
  }, [focusKey]);

  return null;
}
