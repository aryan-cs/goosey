import type { Metadata } from "next";
import { EmailVerificationFlow } from "@/components/email-verification-flow";

export const metadata: Metadata = { title: "Verify your email" };

export default function VerifyEmailPage() {
  return <div className="auth-page"><div className="auth-texture" aria-hidden="true" /><EmailVerificationFlow /></div>;
}
