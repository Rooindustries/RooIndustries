import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { salesPath } from "../lib/salesPaths";
import { trackEvent, trackPageView } from "../lib/analytics";
import { withSalesAttribution } from "../lib/analyticsModules";
import { keepPostHogEvent } from "../lib/loadPostHog";

export default function SalesTelemetry() {
  const location = useLocation();
  const path = salesPath(location.pathname);
  useEffect(() => {
    if (!path) return undefined;
    const view = new AbortController();
    trackPageView(view.signal);
    return () => view.abort();
  }, [path]);
  useEffect(() => {
    if (!path) return;
    const landing = { pathname: window.location.pathname, search: window.location.search };
    keepPostHogEvent("service_visit", { page: path }, { mark: path });
    withSalesAttribution(({ captureSalesAttribution }) => {
      const attribution = captureSalesAttribution(landing);
      if (!attribution) return;
      const key = `sales_visit:${attribution.journeyId}:${path}`;
      try {
        if (sessionStorage.getItem(key)) return;
        const sent = trackEvent("service_visit", { page: path }, { attribution, postHog: false });
        if (sent) sessionStorage.setItem(key, "1");
      } catch {}
    });
  }, [path, location.search]);
  return null;
}
