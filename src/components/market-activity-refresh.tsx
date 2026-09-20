"use client";

import { useEffect } from "react";
import { useBackgroundRouterRefresh } from "./use-background-router-refresh";

/** Refresh server-rendered market activity without resetting the trade form. */
export function MarketActivityRefresh() {
  const { refresh } = useBackgroundRouterRefresh();

  useEffect(() => {
    const timer = window.setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);

  return null;
}
