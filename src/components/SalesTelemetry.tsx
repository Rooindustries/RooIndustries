import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { captureSalesAttribution, salesPath } from "../lib/salesAttribution";
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
  return null;
}
