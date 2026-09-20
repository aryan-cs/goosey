"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

type ScrollSnapshot = {
  x: number;
  y: number;
  anchor: Element | null;
  anchorTop: number | null;
};

function captureScroll(): ScrollSnapshot {
  const y = window.scrollY;
  const probeY = Math.min(Math.max(1, window.innerHeight * 0.25), Math.max(1, window.innerHeight - 1));
  const anchor = document.elementFromPoint(window.innerWidth / 2, probeY);
  return { x: window.scrollX, y, anchor, anchorTop: anchor?.getBoundingClientRect().top ?? null };
}

function restoreScroll(snapshot: ScrollSnapshot) {
  if (snapshot.anchor?.isConnected && snapshot.anchorTop !== null) {
    const delta = snapshot.anchor.getBoundingClientRect().top - snapshot.anchorTop;
    if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, left: 0, behavior: "instant" });
  }
  if (Math.abs(window.scrollY - snapshot.y) > 1 && (!snapshot.anchor?.isConnected || snapshot.anchorTop === null)) {
    window.scrollTo({ top: snapshot.y, left: snapshot.x, behavior: "instant" });
  }
}

/** Merge fresh Server Component data while keeping the reader at the same viewport anchor. */
export function useBackgroundRouterRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const active = useRef(false);
  const snapshot = useRef<ScrollSnapshot | null>(null);
  const sawPending = useRef(false);
  const fallback = useRef<number | null>(null);

  const finish = useCallback(() => {
    if (fallback.current !== null) window.clearTimeout(fallback.current);
    fallback.current = null;
    const saved = snapshot.current;
    snapshot.current = null;
    if (saved) restoreScroll(saved);
    active.current = false;
  }, []);

  const refresh = useCallback(() => {
    if (active.current || document.visibilityState !== "visible" || !navigator.onLine) return;
    active.current = true;
    snapshot.current = captureScroll();
    fallback.current = window.setTimeout(finish, 10_000);
    startTransition(() => router.refresh());
  }, [finish, router]);

  useLayoutEffect(() => {
    if (pending) {
      sawPending.current = true;
      return;
    }
    if (!sawPending.current || !active.current) return;
    sawPending.current = false;
    finish();
  }, [finish, pending]);

  useEffect(() => () => {
    if (fallback.current !== null) window.clearTimeout(fallback.current);
  }, []);

  return { pending, refresh };
}
