import { AuthForm } from "@/components/auth-form";

export default function SignupPage() {
  return <div className="auth-page"><div className="auth-texture" aria-hidden="true" /><AuthForm mode="register" endpoint="/api/auth/register" /></div>;
}
