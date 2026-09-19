"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { orderEntryHref } from "@/lib/order-entry";

export function MobileOrderEntry({ marketSlug, className }: { marketSlug: string; className: string }) {
  const [ticketVisible, setTicketVisible] = useState(false);

  useEffect(() => {
    const ticket = document.querySelector("#order-book .order-entry-card");
    if (!ticket) return;
    const observer = new IntersectionObserver(([entry]) => {
      setTicketVisible(entry.isIntersecting && entry.intersectionRatio >= 0.5);
    }, { threshold: [0, 0.5] });
    observer.observe(ticket);
    return () => observer.disconnect();
  }, [marketSlug]);

  if (ticketVisible) return null;
  return <nav className={className} aria-label="Trade this market">
    <Link className="button" href={orderEntryHref(marketSlug, "YES", "BUY")}>Trade YES</Link>
    <Link className="button" href={orderEntryHref(marketSlug, "NO", "BUY")}>Trade NO</Link>
  </nav>;
}
