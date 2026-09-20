import { EmailVerificationFlow } from "@/components/email-verification-flow";
import { emailVerificationEnabled } from "@/lib/auth";
import { redirect } from "next/navigation";
import { connection } from "next/server";

export default async function VerifyEmailPage() {
  await connection();
  if (!emailVerificationEnabled()) redirect("/");
  return <div className="auth-page auth-page-centered"><div className="auth-texture" aria-hidden="true" /><EmailVerificationFlow /></div>;
}
