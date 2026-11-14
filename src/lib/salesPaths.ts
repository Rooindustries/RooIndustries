import { INDEXABLE_ROUTES } from "./routes";

export const SALES_PATHS = new Set([
  "/", "/packages", "/booking", "/payment", "/payment-success", "/thank-you", "/reviews", "/benchmarks", "/about",
  "/faq", "/contact", "/tools", "/terms", "/privacy",
]);

export const salesPath = (pathname: string) => {
  if (SALES_PATHS.has(pathname)) return pathname;
  return pathname === "/upgrade-xoc" || pathname.startsWith("/upgrade/") ? "/upgrade" : "";
};

const analyticsPath = (pathname: string) => {
  const sales = salesPath(pathname);
  if (sales) return sales;
  return INDEXABLE_ROUTES.includes(pathname) || pathname === "/downloads/utilities" ? pathname : "";
};

export function sanitizeAnalyticsEvent<T extends { url: string; type: string }>(event: T): T | null {
  try {
    const url = new URL(event.url);
    const path = analyticsPath(url.pathname);
    return path ? { ...event, url: `${url.origin}${path}` } : null;
  } catch {
    return null;
  }
}
