"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { formatLocalTime, localTimeIso, type LocalTimePreset } from "@/lib/local-time";
import { formatRelativeTime } from "@/lib/relative-time";

export function LocalTime({
  value,
  preset = "short",
  className,
}: {
  value: string | Date;
  preset?: LocalTimePreset;
  className?: string;
}) {
  const iso = localTimeIso(value);
  const hydrated = useSyncExternalStore(emptySubscribe, clientSnapshot, serverSnapshot);
  const text = hydrated ? formatLocalTime(iso, preset) : formatLocalTime(iso, preset, { locale: "en-CA", timeZone: "UTC" });

  return <time className={className} dateTime={iso}>{text}</time>;
}

export function RelativeLocalTime({ value, now, className }: { value: string | Date; now: string | Date; className?: string }) {
  const iso = localTimeIso(value);
  const initialNow = localTimeIso(now);
  const [clock, setClock] = useState(initialNow);
  const hydrated = useSyncExternalStore(emptySubscribe, clientSnapshot, serverSnapshot);

  useEffect(() => {
    const advance = () => {
      setClock(new Date().toISOString());
    };
    const timer = window.setInterval(advance, 10_000);
    return () => window.clearInterval(timer);
  }, [iso]);

  const title = hydrated ? formatLocalTime(iso, "medium") : formatLocalTime(iso, "medium", { locale: "en-CA", timeZone: "UTC" });
  return <time className={className} dateTime={iso} title={title}>{formatRelativeTime(iso, clock)}</time>;
}

const emptySubscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
