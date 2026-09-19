import { redirect } from "next/navigation";
import { getServerUser } from "./server-session";
import { requiresEmailVerification } from "./auth";

export async function getSettingsUser(section: "profile" | "privacy" | "security" | "notifications") {
  const user = await getServerUser();
  const next = encodeURIComponent(`/settings/${section}`);
  if (!user) redirect(`/login?next=${next}`);
  if (requiresEmailVerification(user)) redirect(`/verify-email?next=${next}`);
  return user;
}
