"use client";

import Link from "next/link";
import { SearchLauncher } from "./search-launcher";
import { Suspense, type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Bell, ChartNoAxesColumnIncreasing, ChevronDown, CircleHelp, Menu, Search, UserRound, Wallet, X } from "lucide-react";
import { FeatherIcon, GooseMark } from "./brand";
import { MARKET_CATEGORIES } from "@/lib/market-categories";
import { EmailVerificationGuard } from "./email-verification-guard";

const primary = [
  { href: "/", label: "Explore" },
  { href: "/markets", label: "Markets" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/community", label: "Community" },
];

function isCurrentPath(pathname: string, href: string) {
  return href === "/" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function MarketMenu() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const selectedCategory = pathname === "/markets" ? searchParams.get("category") : null;

  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        if (menuRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <div className={`market-menu${open ? " is-open" : ""}`} ref={menuRef} onPointerEnter={(event) => {
      if (event.pointerType !== "touch") setOpen(true);
    }} onPointerLeave={() => {
      if (!menuRef.current?.querySelector(".market-menu-panel")?.contains(document.activeElement)) setOpen(false);
    }} onFocus={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(true);
    }} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <Link
        ref={triggerRef}
        className="market-menu-trigger"
        href="/markets"
        aria-expanded={open}
        aria-controls="market-category-menu"
        aria-current={pathname === "/markets" && !selectedCategory ? "page" : undefined}
        data-current={pathname.startsWith("/markets") ? "true" : undefined}
        onClick={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => menuRef.current?.querySelector<HTMLAnchorElement>(".market-menu-panel a")?.focus());
        }}
      >
        Markets <ChevronDown aria-hidden="true" />
      </Link>
      <div className="market-menu-panel" id="market-category-menu" aria-hidden={!open} inert={!open}>
        <div className="market-menu-heading">
          <span>Browse markets</span>
          <Link href="/markets" aria-current={pathname === "/markets" && !selectedCategory ? "page" : undefined} onClick={() => setOpen(false)}>View all</Link>
        </div>
        <nav className="market-category-grid" aria-label="Market categories">
        {MARKET_CATEGORIES.map((category) => {
          const current = selectedCategory === category;
          return <Link className={current ? "active" : undefined} aria-current={current ? "page" : undefined} href={`/markets?category=${encodeURIComponent(category)}`} key={category} onClick={() => setOpen(false)}>{category}</Link>;
        })}
        </nav>
      </div>
    </div>
  );
}

export interface AppShellProps {
  children: ReactNode;
  balance?: number | string | null;
  signedIn?: boolean;
  verificationRequired?: boolean;
  notificationCount?: number;
}

export function AppShell({ children, balance, signedIn = false, verificationRequired = false, notificationCount = 0 }: AppShellProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const morePanel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const panel = morePanel.current;
    const previousOverflow = document.body.style.overflow;
    const mobileViewport = window.matchMedia("(max-width: 1059.98px)");
    function closeOnDesktop() {
      if (!mobileViewport.matches) setMoreOpen(false);
    }
    mobileViewport.addEventListener("change", closeOnDesktop);
    document.body.style.overflow = "hidden";
    panel?.querySelector<HTMLElement>("button, a")?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMoreOpen(false);
        moreButton.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>("button, a[href]")].filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      mobileViewport.removeEventListener("change", closeOnDesktop);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [moreOpen]);

  return (
    <div className="app-shell">
      <EmailVerificationGuard onRedirect={() => setMoreOpen(false)} />
      <header className="site-header" data-auth={signedIn ? "signed-in" : "guest"}>
        <div className="header-inner">
          <Link className="brand" href="/" aria-label="Goosey home">
            <GooseMark className="brand-mark" />
            <span>Goosey</span>
          </Link>
          <nav className="desktop-nav" aria-label="Primary navigation">
            {primary.map((item) => item.href === "/markets"
              ? <Suspense key={item.href} fallback={<Link href="/markets">Markets</Link>}><MarketMenu /></Suspense>
              : <Link key={item.href} href={item.href} aria-current={isCurrentPath(pathname, item.href) ? "page" : undefined}>{item.label}</Link>)}
            {signedIn && !verificationRequired && <Link href="/portfolio" aria-current={isCurrentPath(pathname, "/portfolio") ? "page" : undefined}>Portfolio</Link>}
          </nav>
          <div className="header-actions">
            <SearchLauncher className="search-trigger">
              <Search size={18} />
              <span>Search markets</span>
            </SearchLauncher>
            {signedIn ? (
              verificationRequired ? <Link className="button button-primary header-verify" href="/verify-email">Verify email</Link> : <>
                <Link className="balance-chip" href="/portfolio" aria-label={`Portfolio, ${balance ?? 0} feathers available`}>
                  <FeatherIcon /> <span>{balance ?? 0}</span>
                </Link>
                <Link className="icon-button" href="/wallet" aria-label="Solana wallet" title="Wallet" aria-current={isCurrentPath(pathname, "/wallet") ? "page" : undefined}><Wallet size={19} /></Link>
                <Link className="icon-button notification-trigger" href="/notifications" aria-label={`${notificationCount} unread notification${notificationCount === 1 ? "" : "s"}`}><Bell size={19} />{notificationCount > 0 && <span>{notificationCount > 9 ? "9+" : notificationCount}</span>}</Link>
                <Link className="avatar-button" href="/settings/profile" aria-label="Settings"><UserRound size={18} /></Link>
              </>
            ) : (
              <>
                <Link className="button button-ghost header-login" href="/login">Sign in</Link>
                <Link className="button button-primary header-join" href="/signup" aria-label="Get Goosey">
                  <span className="header-join-label" aria-hidden="true">
                    <span className="header-join-default">Join</span>
                    <span className="header-join-hover">{Array.from("Get Goosey").map((letter, index) => <span className="header-join-letter" style={{ "--letter-index": index } as CSSProperties} key={index}>{letter}</span>)}</span>
                  </span>
                </Link>
              </>
            )}
            <button ref={moreButton} className="mobile-menu-trigger" type="button" aria-label="Open menu" aria-expanded={moreOpen} aria-controls="mobile-more-panel" onClick={() => setMoreOpen(true)}><Menu /></button>
          </div>
        </div>
      </header>
      <main id="main-content">{children}</main>
      <Footer />
      <button className={`mobile-more-backdrop${moreOpen ? " is-open" : ""}`} type="button" tabIndex={-1} aria-hidden="true" onClick={() => { setMoreOpen(false); moreButton.current?.focus(); }} />
      <aside ref={morePanel} className={`mobile-more-panel${moreOpen ? " is-open" : ""}`} id="mobile-more-panel" role="dialog" aria-modal="true" aria-hidden={!moreOpen} aria-label="Navigation menu">
        <div className="mobile-more-heading"><div><span className="eyebrow">Goosey</span><strong>Menu</strong></div><button type="button" aria-label="Close navigation menu" onClick={() => { setMoreOpen(false); moreButton.current?.focus(); }}><X /></button></div>
        <nav aria-label="More destinations">
          <Link href="/" aria-current={isCurrentPath(pathname, "/") ? "page" : undefined} onClick={() => setMoreOpen(false)}>Explore</Link>
          <Link href="/markets" aria-current={isCurrentPath(pathname, "/markets") ? "page" : undefined} onClick={() => setMoreOpen(false)}>Markets</Link>
          <SearchLauncher className="button mobile-search-trigger" onOpen={() => setMoreOpen(false)}>Search</SearchLauncher>
          <Link href="/leaderboard" aria-current={isCurrentPath(pathname, "/leaderboard") ? "page" : undefined} onClick={() => setMoreOpen(false)}>Ranks</Link>
          <Link href="/community" aria-current={isCurrentPath(pathname, "/community") ? "page" : undefined} onClick={() => setMoreOpen(false)}>Social</Link>
          {signedIn ? verificationRequired ? <>
            <Link className="mobile-more-primary" href="/verify-email" onClick={() => setMoreOpen(false)}>Verify email</Link>
          </> : <>
            <Link href="/portfolio" aria-current={isCurrentPath(pathname, "/portfolio") ? "page" : undefined} onClick={() => setMoreOpen(false)}>Portfolio</Link>
            <Link href="/wallet" aria-current={isCurrentPath(pathname, "/wallet") ? "page" : undefined} onClick={() => setMoreOpen(false)}>Wallet</Link>
            <Link href="/watchlist" onClick={() => setMoreOpen(false)}>Watchlist</Link>
            <Link href="/notifications" onClick={() => setMoreOpen(false)}>Notifications{notificationCount > 0 ? ` (${notificationCount})` : ""}</Link>
            <Link href="/settings/profile" onClick={() => setMoreOpen(false)}>Account</Link>
          </> : <>
            <Link href="/login" onClick={() => setMoreOpen(false)}>Sign in</Link>
            <Link className="mobile-more-primary" href="/signup" onClick={() => setMoreOpen(false)}>Create account</Link>
          </>}
          <Link href="/settings/appearance" onClick={() => setMoreOpen(false)}>Appearance</Link>
          <Link href="/rules" onClick={() => setMoreOpen(false)}>How markets work</Link>
        </nav>
      </aside>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <GooseMark className="brand-mark" />
          <div><strong>Goosey</strong><p>Predict Hack the North with play-money feathers.</p></div>
        </div>
        <div className="footer-links">
          <Link href="/markets"><ChartNoAxesColumnIncreasing size={16} /> Markets</Link>
          <Link href="/rules">How markets work</Link>
          <Link href="/community">Community</Link>
          <Link href="/settings">Settings</Link>
          <Link href="/settings/privacy">Privacy</Link>
        </div>
        <div className="footer-bottom">
          <p className="legal">Play-money only. Goosey is an independent community project and is not an official University of Waterloo or Hack the North service.</p>
          <a
            className="footer-issue-link"
            href="https://forms.gle/uJVou9X5Gfppeuk67"
            target="_blank"
            rel="noreferrer"
            aria-label="Report an issue with Goosey (opens in a new tab)"
          >
            <CircleHelp aria-hidden="true" />
            Report an issue
          </a>
        </div>
      </div>
    </footer>
  );
}
