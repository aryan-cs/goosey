import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { getServerUser } from "@/lib/server-session";
import { formatFeathers } from "@/lib/view-models";
import { db } from "@/lib/db";
import { requiresEmailVerification } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Goosey | Campus predictions",
    template: "%s · Goosey",
  },
  description:
    "A play-money prediction exchange for the University of Waterloo and Hack the North community.",
  applicationName: "Goosey",
  icons: {
    icon: [
      { url: "/brand/goosey-mark-dark.png", media: "(prefers-color-scheme: light)" },
      { url: "/brand/goosey-mark.png", media: "(prefers-color-scheme: dark)" },
    ],
  },
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const user = await getServerUser();
  const verificationRequired = user ? requiresEmailVerification(user) : false;
  const notificationCount = user && !verificationRequired ? await db.notification.count({ where: { userId: user.id, readAt: null } }) : 0;

  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <AppShell signedIn={Boolean(user)} verificationRequired={verificationRequired} balance={user && !verificationRequired ? formatFeathers(user.balanceMilli, 2) : null} notificationCount={notificationCount}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
