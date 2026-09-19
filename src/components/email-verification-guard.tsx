"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { EMAIL_VERIFICATION_REQUIRED_EVENT } from "@/lib/client-api";

export function EmailVerificationGuard({ onRedirect }: { onRedirect?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const redirecting = useRef(false);

  useEffect(() => {
    const requireVerification = () => {
      if (redirecting.current || pathname === "/verify-email") return;
      redirecting.current = true;
      onRedirect?.();
      const next = `${window.location.pathname}${window.location.search}`;
      router.push(`/verify-email?next=${encodeURIComponent(next)}`);
    };
    window.addEventListener(EMAIL_VERIFICATION_REQUIRED_EVENT, requireVerification);
    return () => window.removeEventListener(EMAIL_VERIFICATION_REQUIRED_EVENT, requireVerification);
  }, [onRedirect, pathname, router]);

  return null;
}
