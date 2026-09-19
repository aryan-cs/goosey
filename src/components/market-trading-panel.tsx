"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, X } from "lucide-react";
import { TradeTicket, type TradeTicketProps } from "./trade-ticket";

type Outcome = "YES" | "NO";
type TradeEntryDetail = { outcome: Outcome; trigger: HTMLElement };

export function MarketTradeLink({ outcome, probability, className, children }: { outcome: Outcome; probability: number; className: string; children?: ReactNode }) {
  const label = outcome === "YES" ? "Yes" : "No";
  return (
    <a
      className={className}
      href={`?outcome=${outcome}#trade`}
      aria-label={`Trade ${label} at ${probability} percent`}
      onClick={(event) => {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent<TradeEntryDetail>("goosey:open-trade", { detail: { outcome, trigger: event.currentTarget } }));
      }}
    >
      {children ?? `Trade ${outcome}`}
    </a>
  );
}

export function MarketTradingPanel(props: TradeTicketProps) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(props.initialOutcome ?? "YES");
  const closeButton = useRef<HTMLButtonElement>(null);
  const ticketShell = useRef<HTMLDivElement>(null);
  const triggerButton = useRef<HTMLElement | null>(null);
  const yesPercent = Math.round(props.yesProbability * 100);
  const noPercent = Math.round((props.noProbability ?? 1 - props.yesProbability) * 100);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    closeButton.current?.focus({ preventScroll: true });
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(ticketShell.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter((element) => !element.hidden);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      window.removeEventListener("keydown", handleDialogKeys);
      triggerButton.current?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const shell = ticketShell.current;
    if (!shell) return;
    const viewport = window.visualViewport;
    let animationFrame = 0;
    const syncVisibleViewport = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const height = Math.max(320, viewport?.height ?? window.innerHeight);
        const offsetTop = Math.max(0, viewport?.offsetTop ?? 0);
        shell.style.setProperty("--trade-vv-height", `${height}px`);
        shell.style.setProperty("--trade-vv-top", `${offsetTop}px`);
      });
    };
    syncVisibleViewport();
    viewport?.addEventListener("resize", syncVisibleViewport);
    viewport?.addEventListener("scroll", syncVisibleViewport);
    window.addEventListener("orientationchange", syncVisibleViewport);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      viewport?.removeEventListener("resize", syncVisibleViewport);
      viewport?.removeEventListener("scroll", syncVisibleViewport);
      window.removeEventListener("orientationchange", syncVisibleViewport);
      shell.style.removeProperty("--trade-vv-height");
      shell.style.removeProperty("--trade-vv-top");
    };
  }, [open]);

  useEffect(() => {
    const sheetBreakpoint = window.matchMedia("(max-width: 959.98px)");
    const closeWhenInline = () => {
      if (!sheetBreakpoint.matches) setOpen(false);
    };
    sheetBreakpoint.addEventListener("change", closeWhenInline);
    return () => sheetBreakpoint.removeEventListener("change", closeWhenInline);
  }, []);

  useEffect(() => {
    const openFromForecast = (event: Event) => {
      const { outcome: nextOutcome, trigger } = (event as CustomEvent<TradeEntryDetail>).detail;
      setOutcome(nextOutcome);
      triggerButton.current = trigger;
      if (window.matchMedia("(max-width: 959.98px)").matches) setOpen(true);
      else document.getElementById("trade")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("goosey:open-trade", openFromForecast);
    return () => window.removeEventListener("goosey:open-trade", openFromForecast);
  }, []);

  function openFor(nextOutcome: Outcome, trigger: HTMLElement) {
    triggerButton.current = trigger;
    setOutcome(nextOutcome);
    setOpen(true);
  }

  return (
    <div id="trade" className={`market-trade-aside trading-panel${open ? " mobile-open" : ""}`}>
      <button className="sheet-backdrop" type="button" aria-label="Close trade ticket" onClick={() => setOpen(false)} />
      <div ref={ticketShell} className="ticket-shell" role={open ? "dialog" : undefined} aria-modal={open ? "true" : undefined} aria-label={open ? `Trade ${props.marketTitle}` : undefined}>
        <div className="sheet-handle" aria-hidden="true" />
        <button ref={closeButton} className="sheet-close" type="button" aria-label="Close trade ticket" onClick={() => setOpen(false)}><X /></button>
        <TradeTicket {...props} initialOutcome={outcome} key={outcome} />
      </div>

      <div className="mobile-trade-dock" aria-label="Quick trade entry">
        <div className="dock-forecast"><span>Current forecast</span><strong>{yesPercent}% Yes</strong></div>
        {props.disabled ? <button className="dock-closed" type="button" disabled>Market closed</button> : <>
          <button className="dock-side dock-yes" type="button" onClick={(event) => openFor("YES", event.currentTarget)}><span>Trade Yes</span><strong>{yesPercent}%</strong></button>
          <button className="dock-side dock-no" type="button" onClick={(event) => openFor("NO", event.currentTarget)}><span>Trade No</span><strong>{noPercent}%</strong></button>
        </>}
        <ArrowUp className="dock-cue" aria-hidden="true" />
      </div>

      <style>{`
        .sheet-backdrop, .sheet-close, .sheet-handle, .mobile-trade-dock { display: none; }
        @media (max-width: 959.98px) {
          .trading-panel { margin: 0; max-width: none; }
          .trading-panel .ticket-shell {
            --trade-sheet-height: min(760px, calc(var(--trade-vv-height, 100vh) - 8px));
            position: fixed; z-index: 80; left: max(0px, calc((100vw - 520px) / 2)); right: max(0px, calc((100vw - 520px) / 2));
            top: calc(var(--trade-vv-top, 0px) + var(--trade-vv-height, 100vh) - var(--trade-sheet-height)); bottom: auto; display: block;
            height: var(--trade-sheet-height); max-height: calc(var(--trade-vv-height, 100vh) - 8px); min-height: 0; overflow-x: hidden; overflow-y: auto;
            overscroll-behavior-y: contain; -webkit-overflow-scrolling: touch; touch-action: pan-y;
            scroll-padding-block: 12px calc(88px + env(safe-area-inset-bottom));
            background: var(--panel-glass-solid); border-radius: var(--radius-lg) var(--radius-lg) 0 0;
            box-shadow: none;
            opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(24px);
            transition: opacity var(--motion-base) var(--ease-standard), transform var(--motion-base) var(--ease-emphasized), visibility 0s linear var(--motion-base);
          }
          .sheet-backdrop {
            position: fixed; z-index: 79; inset: 0; display: block; border: 0;
            background: rgb(20 22 16 / 48%); opacity: 0; visibility: hidden; pointer-events: none;
            transition: opacity var(--motion-base) var(--ease-standard), visibility 0s linear var(--motion-base);
          }
          .mobile-trade-dock {
            position: fixed; z-index: 70; left: max(16px, calc((100vw - 520px) / 2)); right: max(16px, calc((100vw - 520px) / 2));
            bottom: calc(env(safe-area-inset-bottom) + 8px);
            min-height: 66px; display: grid; grid-template-columns: minmax(96px, 1fr) 1fr 1fr;
            align-items: center; gap: 7px; padding: 8px;
            background: var(--panel-glass-solid);
            border: 0; border-radius: var(--radius-md); box-shadow: none;
            opacity: 1; visibility: visible; transform: translateY(0);
            transition: opacity var(--motion-base) var(--ease-standard), transform var(--motion-base) var(--ease-emphasized), visibility 0s linear 0s;
          }
          .dock-forecast { min-width: 0; display: grid; padding-left: 4px; }
          .dock-forecast span { color: var(--ink-muted); font-size: 10px; }
          .dock-forecast strong { overflow: hidden; font: 750 15px var(--font-display); white-space: nowrap; }
          .dock-side, .dock-closed {
            min-height: 48px; display: grid; place-content: center; gap: 1px; border: 0;
            border-radius: 10px; cursor: pointer; font: inherit;
            transition: color var(--motion-fast) var(--ease-standard), background-color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-base) var(--ease-standard), transform var(--motion-base) var(--ease-emphasized);
          }
          .dock-side:hover { transform: translateY(-2px); box-shadow: var(--shadow-card); }.dock-side:active { transform: translateY(0) scale(.98); }
          .dock-side span { font-size: 11px; font-weight: 750; }
          .dock-side strong { font: 800 15px var(--font-data); }
          .dock-yes { color: var(--yes); background: var(--yes-soft); }
          .dock-no { color: var(--no); background: var(--no-soft); }
          .dock-closed { grid-column: span 2; color: var(--ink-muted); background: var(--surface-sunken); }
          .dock-cue { display: none; }
          .mobile-open .sheet-backdrop { opacity: 1; visibility: visible; pointer-events: auto; transition-delay: 0s; }
          .mobile-open .ticket-shell { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0); transition-delay: 0s; }
          .mobile-open .mobile-trade-dock { opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(12px); transition-delay: 0s, 0s, var(--motion-base); }
          .sheet-close {
            position: absolute; z-index: 2; top: 9px; right: 10px; width: 44px; height: 44px;
            display: grid; place-items: center; padding: 0; color: var(--ink-muted);
            background: var(--surface-sunken); border: 0; border-radius: 50%; cursor: pointer;
            transition: color var(--motion-fast) var(--ease-standard), background-color var(--motion-fast) var(--ease-standard), transform var(--motion-base) var(--ease-emphasized);
          }
          .sheet-close:hover { color: var(--ink); background: var(--border); transform: rotate(4deg) scale(1.04); }.sheet-close:active { transform: rotate(0) scale(.96); }
          .sheet-close svg { width: 18px; height: 18px; }
          .sheet-handle { width: 38px; height: 4px; display: block; margin: 7px auto -5px; background: var(--border); border-radius: 999px; }
          .ticket-shell .trade-ticket { max-height: none; overflow: visible; background: transparent; border: 0; box-shadow: none; }
          .ticket-shell .trade-ticket-header { padding-right: 40px; }
          .ticket-shell .trade-ticket-header > svg { display: none; }
          .ticket-shell .trade-actions {
            position: sticky; z-index: 3; bottom: 0;
            padding: 12px 0 max(12px, env(safe-area-inset-bottom));
            background: var(--panel-glass-solid);
          }
          @supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
            .ticket-shell, .mobile-trade-dock { background: var(--panel-glass); -webkit-backdrop-filter: blur(48px); backdrop-filter: blur(48px); }
          }
        }
        @media (max-width: 390px) {
          .mobile-trade-dock { grid-template-columns: 82px 1fr 1fr; left: 6px; right: 6px; gap: 5px; }
          .dock-forecast strong { font-size: 13px; }
        }
      `}</style>
    </div>
  );
}
