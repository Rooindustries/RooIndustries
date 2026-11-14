"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { isProductionBrowser } from "../lib/productionBrowser";
import { Analytics } from "@vercel/analytics/react";
import { sanitizeAnalyticsEvent } from "../lib/salesPaths";
import { initializePerformanceProfile } from "../lib/performanceProfile";
import { rememberReferralFromSearch } from "../lib/checkoutStorage";
import { reportRequestError } from "../lib/clientRequest";

const CHECKOUT_PATHS = ["/booking", "/payment", "/payment-success", "/thank-you"];
const SEORCE_PROJECT_ID = "6a2e76bf3f9dac8c30e27b89";
const SEORCE_SCRIPT_ID = "seorce-runtime-script";
const STAFF_PREFIXES = ["/admin"];
// Seorce retries its tracking-config fetch every 90 seconds and logs failures.
// Keep that third-party loop and production analytics off preview/local hosts.
const SEORCE_BLOCKED_PREFIXES = [
  "/tourney",
  "/booking",
  "/payment",
  "/payment-success",
  "/thank-you",
  "/referrals",
  ...STAFF_PREFIXES,
];

const onRoutes = (pathname, prefixes) =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

const getPathname = () =>
  typeof window === "undefined" ? "" : window.location.pathname || "/";

const getHostname = () =>
  typeof window === "undefined" ? "" : window.location.hostname || "";

export const shouldLoadSeorce = (
  pathname = getPathname(),
  hostname = getHostname()
) =>
  isProductionBrowser(hostname) && !onRoutes(pathname, SEORCE_BLOCKED_PREFIXES);

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

export default function AppClientRuntime() {
  const [analyticsEnabled, setAnalyticsEnabled] = useState(false);
  const [ConsentRuntime, setConsentRuntime] = useState(null);
  const staffPage = onRoutes(usePathname() ?? "", STAFF_PREFIXES);

  useEffect(() => {
    setAnalyticsEnabled(isProductionBrowser());
  }, []);
  useEffect(() => {
    initializePerformanceProfile();
  }, []);
  useEffect(() => {
    if (!CHECKOUT_PATHS.includes(window.location.pathname)) rememberReferralFromSearch(window.location.search);
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

  useEffect(() => {
    if (staffPage) return undefined;
    let cancelled = false;
    const cleanup = runWhenIdle(() => {
      import("./ConsentRuntime").then(({ default: Runtime }) => {
        if (!cancelled) setConsentRuntime(() => Runtime);
      }).catch(reportRequestError);
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [staffPage]);

  return (
    <>
      {analyticsEnabled ? <Analytics beforeSend={sanitizeAnalyticsEvent} /> : null}
      {ConsentRuntime && !staffPage ? <ConsentRuntime /> : null}
    </>
  );
}
