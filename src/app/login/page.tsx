import { AuthForm } from "@/components/auth-form";

export default function LoginPage() {
  return <div className="auth-page"><div className="auth-texture" aria-hidden="true" /><AuthForm mode="login" endpoint="/api/auth/login" /></div>;
}
