"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const Analytics = dynamic(
  () => import("@vercel/analytics/react").then((module) => module.Analytics),
  { ssr: false }
);
const SpeedInsights = dynamic(
  () =>
    import("@vercel/speed-insights/react").then(
      (module) => module.SpeedInsights
    ),
  { ssr: false }
);

const TELEMETRY_BLOCKED_PREFIXES = [
  "/tourney/register",
  "/tourney/login",
  "/tourney/forgot",
  "/tourney/reset",
  "/tourney/manage",
  "/tourney/payouts",
];

const isBlockedPath = (pathname = "") =>
  TELEMETRY_BLOCKED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

const runWhenIdle = (callback) => {
  if (typeof window === "undefined") return () => {};
  if ("requestIdleCallback" in window) {
    const idleId = window.requestIdleCallback(callback, { timeout: 5000 });
    return () => window.cancelIdleCallback?.(idleId);
  }
  const timeoutId = window.setTimeout(callback, 1600);
  return () => window.clearTimeout(timeoutId);
};

export default function TourneyTelemetry() {
  const pathname = usePathname() || "";
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(false);
    if (isBlockedPath(pathname)) return undefined;

    let cancelled = false;
    const cleanup = runWhenIdle(() => {
      if (!cancelled) {
        setEnabled(true);
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [pathname]);

  if (!enabled) return null;

  return (
    <>
      <Analytics />
      <SpeedInsights />
    </>
  );
}
