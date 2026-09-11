import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import { captureSalesAttribution, salesPath, sanitizeAnalyticsEvent } from "../lib/salesAttribution";
import { trackEvent } from "../lib/analytics";

export default function SalesTelemetry() {
  const location = useLocation();
  const path = salesPath(location.pathname);
  useEffect(() => {
    if (!path) return;
    const attribution = captureSalesAttribution();
    if (!attribution) return;
    const key = `sales_visit:${attribution.journeyId}:${path}`;
    try {
      if (sessionStorage.getItem(key)) return;
      if (trackEvent("service_visit", { page: path })) sessionStorage.setItem(key, "1");
    } catch {}
  }, [path, location.search]);
  return path ? <Analytics beforeSend={sanitizeAnalyticsEvent} /> : null;
}
