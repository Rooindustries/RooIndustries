import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { isProductionBrowser } from "../lib/productionBrowser";

const start = () => {
  import("../lib/posthog").then(({ startPostHog }) => startPostHog()).catch(() => {});
};

export default function PostHogRuntime() {
  const { pathname } = useLocation();

  useEffect(() => {
    if (!isProductionBrowser()) return undefined;
    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(start, { timeout: 4000 });
      return () => window.cancelIdleCallback?.(idleId);
    }
    const timeoutId = window.setTimeout(start, 1200);
    return () => window.clearTimeout(timeoutId);
  }, [pathname]);

  return null;
}
