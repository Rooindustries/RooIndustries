"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { isProductionBrowser } from "../lib/productionBrowser";
import { Analytics } from "@vercel/analytics/react";
import { sanitizeAnalyticsEvent } from "../lib/salesAttribution";
import { initializePerformanceProfile } from "../lib/performanceProfile";
import { rememberReferralFromSearch } from "../lib/checkoutStorage";

const CHECKOUT_PATHS = ["/booking", "/payment", "/payment-success", "/thank-you"];
const SEORCE_PROJECT_ID = "6a2e76bf3f9dac8c30e27b89";
const SEORCE_SCRIPT_ID = "seorce-runtime-script";
// Seorce retries its tracking-config fetch every 90 seconds and logs failures.
// Keep that third-party loop and production analytics off preview/local hosts.
const SEORCE_BLOCKED_PREFIXES = [
  "/tourney",
  "/booking",
  "/payment",
  "/payment-success",
  "/thank-you",
  "/referrals",
  "/admin",
];

const getPathname = () =>
  typeof window === "undefined" ? "" : window.location.pathname || "/";

const getHostname = () =>
  typeof window === "undefined" ? "" : window.location.hostname || "";

export const shouldLoadSeorce = (
  pathname = getPathname(),
  hostname = getHostname()
) =>
  isProductionBrowser(hostname) &&
  !SEORCE_BLOCKED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

const runWhenIdle = (callback) => {
  if (typeof window === "undefined") return () => {};
  if ("requestIdleCallback" in window) {
    const idleId = window.requestIdleCallback(callback, { timeout: 4000 });
    return () => window.cancelIdleCallback?.(idleId);
  }
  const timeoutId = window.setTimeout(callback, 1200);
  return () => window.clearTimeout(timeoutId);
};

export const loadSeorceScript = ({
  pathname = getPathname(),
  hostname = getHostname(),
} = {}) => {
  if (
    typeof document === "undefined" ||
    !shouldLoadSeorce(pathname, hostname)
  ) {
    return false;
  }
  if (document.getElementById(SEORCE_SCRIPT_ID)) return true;

  const script = document.createElement("script");
  script.id = SEORCE_SCRIPT_ID;
  script.src = `https://scripts.seorce.com/api?projectId=${SEORCE_PROJECT_ID}`;
  script.async = true;
  script.defer = true;
  script.dataset.uuid = SEORCE_PROJECT_ID;
  document.head.appendChild(script);
  return true;
};

function ReferralCapture() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (pathname && !CHECKOUT_PATHS.includes(pathname)) rememberReferralFromSearch(searchParams?.toString());
  }, [pathname, searchParams]);

  return null;
}

export default function AppClientRuntime() {
  const [analyticsEnabled, setAnalyticsEnabled] = useState(false);

  useEffect(() => {
    setAnalyticsEnabled(isProductionBrowser());
  }, []);
  useEffect(() => {
    initializePerformanceProfile();
  }, []);
  useEffect(() => {
    let cancelled = false;
    const cleanup = runWhenIdle(() => {
      if (!cancelled) {
        loadSeorceScript();
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  return (
    <>
      <Suspense fallback={null}>
        <ReferralCapture />
      </Suspense>
      {analyticsEnabled ? <Analytics beforeSend={sanitizeAnalyticsEvent} /> : null}
    </>
  );
}
