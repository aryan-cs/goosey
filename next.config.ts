import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default function configureNext(phase: string): NextConfig {
  const development = phase === PHASE_DEVELOPMENT_SERVER;
  const scriptPolicy = development
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";

  return {
    // Keep `next build` from clearing a running dev server's client and HMR
    // artifacts. Next otherwise places both beneath `.next`.
    distDir: development
      ? (process.env.GOOSEY_DEVELOPMENT_SANDBOX === "1" ? ".next-sandbox" : ".next-dev")
      : ".next",
    // Codex/AppShots and local QA address the same dev server through both
    // loopback hostnames. Next validates dev-only HMR origins separately.
    allowedDevOrigins: ["127.0.0.1"],
    poweredByHeader: false,
    devIndicators: false,
    turbopack: {
      root: process.cwd(),
    },
    async headers() {
      return [
        {
          source: "/(.*)",
          headers: [
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "X-Frame-Options", value: "DENY" },
            { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
            { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
            {
              key: "Content-Security-Policy",
              value:
                `default-src 'self'; ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src https://sketchfab.com https://*.sketchfab.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
            },
            ...(!development
              ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
              : []),
          ],
        },
      ];
    },
  };
}
