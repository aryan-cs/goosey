import { AuthForm } from "@/components/auth-form";
import { authDestination } from "@/lib/auth-destination";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const next = authDestination((await searchParams).next);
  return <div className="auth-page"><div className="auth-texture" aria-hidden="true" /><AuthForm mode="login" endpoint="/api/auth/login" redirectTo={next} /></div>;
}
