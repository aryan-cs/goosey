const BASE_ORIGIN = "https://goosey.invalid";
const AUTH_PATHS = new Set(["/login", "/signup", "/verify-email", "/reset-password"]);

/** Keep account handoffs on a local product page and avoid authentication loops. */
export function authDestination(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith("//")) return "/";
    const url = new URL(value, BASE_ORIGIN);
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";
    if (url.origin !== BASE_ORIGIN || AUTH_PATHS.has(path) || path === "/api" || path.startsWith("/api/")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function authPageHref(page: "/login" | "/signup" | "/reset-password", destination: unknown): string {
  const next = authDestination(destination);
  return next === "/" ? page : `${page}?next=${encodeURIComponent(next)}`;
}
