import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { buildPublicBrowserRuntime } from "./src/lib/solana/browser-runtime";
import { resolveSolanaRuntime } from "./src/lib/solana/runtime";
import { MARKET_SUGGESTION_FORM_URL } from "./src/lib/market-suggestion";

export default function configureNext(phase: string): NextConfig {
  const development = phase === PHASE_DEVELOPMENT_SERVER;
  const scriptPolicy = development
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  // Same explicit capability as the status API; never whitelist private RPC
  // hosts or all HTTPS endpoints. Read at config/build time, not from requests.
  const browser = process.env.GOOSEY_SOLANA_BROWSER_ENABLED === "true"
    ? buildPublicBrowserRuntime(resolveSolanaRuntime(), process.env) : null;
  const connectPolicy = `connect-src 'self'${browser?.enabled ? ` ${new URL(browser.publicRpcUrl).origin}` : ""}`;

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
    async redirects() {
      const canonicalHostRedirects = ["goosey-test.vercel.app", "goosey-test-bowens-projects-b0c91e9e.vercel.app"].map((host) => ({
        source: "/:path*",
        has: [{ type: "host" as const, value: host }],
        destination: "https://getgoosey.vercel.app/:path*",
        permanent: true,
      }));
      return [
        { source: "/markets/suggest", destination: MARKET_SUGGESTION_FORM_URL, permanent: false },
        ...canonicalHostRedirects,
      ];
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
                `default-src 'self'; ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; ${connectPolicy}; frame-src https://sketchfab.com https://*.sketchfab.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
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
