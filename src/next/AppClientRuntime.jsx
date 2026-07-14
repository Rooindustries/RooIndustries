"use client";

import { useEffect } from "react";
import { initializePerformanceProfile } from "../lib/performanceProfile";

const SEORCE_PROJECT_ID = "6a2e76bf3f9dac8c30e27b89";
const SEORCE_SCRIPT_ID = "seorce-runtime-script";
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

const shouldLoadSeorce = (pathname = getPathname()) =>
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

const loadSeorceScript = () => {
  if (typeof document === "undefined" || !shouldLoadSeorce()) return;
  if (document.getElementById(SEORCE_SCRIPT_ID)) return;

  const script = document.createElement("script");
  script.id = SEORCE_SCRIPT_ID;
  script.src = `https://scripts.seorce.com/api?projectId=${SEORCE_PROJECT_ID}`;
  script.async = true;
  script.defer = true;
  script.dataset.uuid = SEORCE_PROJECT_ID;
  document.head.appendChild(script);
};

export default function AppClientRuntime() {
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

  return null;
}
