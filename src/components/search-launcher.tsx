"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { SearchExperience } from "./search-experience";
import styles from "./search-launcher.module.css";

export function SearchLauncher({ children, className, onOpen }: { children: ReactNode; className?: string; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, [open]);

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => {
      dialog.current?.close();
      setOpen(false);
      setClosing(false);
      if (trigger.current && getComputedStyle(trigger.current).visibility !== "hidden") trigger.current.focus();
      else document.querySelector<HTMLButtonElement>(".mobile-menu-trigger")?.focus();
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
    return () => window.clearTimeout(timer);
  }, [closing]);

  return <>
    <button ref={trigger} type="button" className={className} aria-label="Search markets" aria-haspopup="dialog" onClick={() => { setClosing(false); setOpen(true); onOpen?.(); }}>{children}</button>
    {open && createPortal(<dialog ref={dialog} className={`${styles.dialog} ${closing ? styles.closing : ""}`} aria-label="Search Goosey" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setClosing(true); } }} onCancel={(event) => { event.preventDefault(); setClosing(true); }} onClick={(event) => { if (event.target === event.currentTarget || (event.target instanceof Element && event.target.closest("a"))) setClosing(true); }}>
      <div className={styles.content}>
        <div className={styles.heading}><h2>Search Goosey</h2><button type="button" className="icon-button" aria-label="Close search" onClick={() => setClosing(true)}><X /></button></div>
        <SearchExperience syncUrl={false} />
      </div>
    </dialog>, document.body)}
  </>;
}
