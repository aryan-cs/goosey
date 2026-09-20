import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function userProfileHref(username: string) {
  return `/users/${encodeURIComponent(username)}`;
}

export function UserProfileLink({ username, children, ...props }: Omit<ComponentProps<typeof Link>, "href"> & { username: string; children: ReactNode }) {
  return <Link href={userProfileHref(username)} {...props}>{children}</Link>;
}
