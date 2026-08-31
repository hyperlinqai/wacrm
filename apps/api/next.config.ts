import path from "node:path";
import type { NextConfig } from "next";

/**
 * Security headers for API responses.
 *
 * The web app's set is tuned for documents (CSP, Permissions-Policy,
 * frame-ancestors); none of that means anything on a JSON body. What
 * survives is what still protects an API: nosniff, HSTS, a referrer
 * policy, and a framing denial for the handful of routes that do return
 * a document-ish body (the embed widget script).
 */
const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
] as const;

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image, same as the web app.
  output: "standalone",

  // This app lives at apps/api inside the wacrm monorepo (npm
  // workspaces), not at the filesystem root Next.js would otherwise
  // infer. Without this, the standalone build's file tracing can miss
  // hoisted workspace node_modules and silently ship an incomplete
  // server bundle.
  outputFileTracingRoot: path.join(__dirname, "../.."),

  // Workspace packages ship raw TypeScript (no build step) — Next
  // transpiles them itself rather than expecting compiled JS.
  transpilePackages: ["@wacrm/roles", "@wacrm/shared"],

  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        // Overrides the no-store rule above for one specific public,
        // unauthenticated route: the Web Forms embed widget script.
        // Unlike every other /api/* response, this one isn't per-user —
        // the same organization's form config produces the same script
        // for every visitor — so it's safe (and, on a high-traffic
        // landing page, important) to let it sit in a shared/edge cache
        // briefly. Matches the widget route's own Cache-Control header;
        // this rule exists only because the broader /api/* rule above
        // would otherwise win. Later-matching rules override earlier
        // ones for the same header key (Next.js headers() semantics).
        source: "/api/public/lead-forms/:formId/widget.js",
        headers: [
          {
            key: "Cache-Control",
            value:
              "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
          },
        ],
      },
      { source: "/:path*", headers: [...SECURITY_HEADERS] },
    ];
  },
};

export default nextConfig;
