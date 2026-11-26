import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { salesPath } from "../lib/salesPaths";
import { trackEvent, trackPageView } from "../lib/analytics";
import { withSalesAttribution } from "../lib/analyticsModules";
import { keepPostHogEvent, setCurrentArrivalSnapshot, snapRawAttr } from "../lib/loadPostHog";
import { captureArrivalSnapshot, sameOrNarrowerAttribution } from "../lib/arrivalSnapshot";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function SalesTelemetry() {
  const { key: locKey, pathname, search } = useLocation();
  const navType = useNavigationType();
  const path = salesPath(pathname);
  const arrivalRef = useRef<{ key: string; snap: ReturnType<typeof captureArrivalSnapshot>; mounted: boolean; sent: unknown }>({ key: "", snap: null, mounted: false, sent: null });
  const aKey = `${locKey}|${pathname}|${search}`;
  useIsomorphicLayoutEffect(() => {
    const cur = arrivalRef.current;
    if (!path) {
      cur.mounted = true;
      if (!cur.snap) return;
      cur.key = "";
      cur.snap = null;
      setCurrentArrivalSnapshot(null);
      return;
    }
    if (cur.key === aKey) return;
    const navEntry = !cur.mounted ? (performance.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined)?.type : "";
    const revisit = cur.mounted ? (navType !== "PUSH" ? 1 : 0) : navEntry === "back_forward" || navEntry === "reload" ? 2 : 0;
    cur.mounted = true;
    if (navType === "REPLACE" && cur.snap?.landingPath === path && sameOrNarrowerAttribution(cur.snap.search, search)) {
      cur.key = aKey;
      return;
    }
    const snap = captureArrivalSnapshot({ pathname, search, revisit, entryKey: locKey });
    cur.key = aKey;
    cur.snap = snap;
    setCurrentArrivalSnapshot(snap);
  }, [aKey, locKey, pathname, search, navType, path]);
  useEffect(() => {
    if (!path) return undefined;
    const view = new AbortController();
    trackPageView(view.signal);
    return () => view.abort();
  }, [path]);
  useEffect(() => {
    const landing = arrivalRef.current.snap;
    if (!path || !landing || arrivalRef.current.sent === landing) return;
    arrivalRef.current.sent = landing;
    if (landing.hasParams && !landing.revisit) import("../lib/pendingArrival").then(({ persistPendingArrival }) => persistPendingArrival(landing)).catch(() => {});
    const prior = snapRawAttr();
    keepPostHogEvent("service_visit", { page: path }, { mark: path, landing, prior });
    withSalesAttribution(({ captureVisit }) => {
      const attribution = captureVisit(landing, prior);
      if (!attribution || !("journeyId" in attribution)) return;
      const key = `sales_visit:${attribution.journeyId}:${path}`;
      try {
        if (!sessionStorage.getItem(key) && trackEvent("service_visit", { page: path }, { attribution, postHog: false })) sessionStorage.setItem(key, "1");
      } catch {}
    });
  }, [aKey, path]);
  return null;
}
