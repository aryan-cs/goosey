import { PasswordResetFlow } from "@/components/password-reset-flow";
import { authDestination } from "@/lib/auth-destination";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const next = authDestination((await searchParams).next);
  return <div className="auth-page"><div className="auth-texture" aria-hidden="true" /><PasswordResetFlow redirectTo={next} /></div>;
}
