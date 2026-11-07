import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { HOME_SECTION_PREFETCH_BY_HASH, prefetchHomeSectionData, readHomeSectionData } from "./homeSectionData";
import { alignToHashTarget, getCssHeaderOffsetPx } from "./scrollCoordinator";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect";
import { sanitizeBrowserSearch } from "./browserSearch";
import {
  announceSectionTarget,
  buildHomeSectionHref,
  clearPendingSectionTarget,
  clearRouteTransitionIntent,
  isHomeSectionHash,
  isSupersededSectionTrip,
  normalizeSectionHash,
  readPendingSectionTarget,
  SECTION_TRIP_ENTRY,
  withoutSupersededSectionTrip,
  writePendingSectionTarget,
  writeRouteTransitionIntent,
} from "./sectionNavigation";

const SectionNavigationContext = createContext(null);
const ActiveHomeSectionContext = createContext("");
const tripDocumentKey = Math.random().toString(36).slice(2);
let nextTripKey = 0;

const getHeaderOffsetPx = () => getCssHeaderOffsetPx(110);

const isPlainPrimaryClick = (event, link = event.currentTarget) =>
  !event.defaultPrevented &&
  !event.button &&
  !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) &&
  /^(_self)?$/.test(link.getAttribute("target") || "");

const replaceBrowserUrl = (hash = "", href = `${window.location.pathname}${window.location.search}${hash}`) =>
  window.history.replaceState(window.history.state, "", href);

const clearTripEntry = () => {
  const { [SECTION_TRIP_ENTRY]: marker, ...state } = window.history.state || {};
  if (marker) window.history.replaceState(state, "", window.location.href);
};

const prefetchSectionData = (hash) => {
  const requiredKeys = HOME_SECTION_PREFETCH_BY_HASH[hash] || [];
  const missingKeys = requiredKeys.filter((key) => readHomeSectionData(key) === null);
  if (missingKeys.length > 0) {
    prefetchHomeSectionData(missingKeys).catch(() => {});
  }
};

export function SectionNavigationProvider({ routeShell = "browser", children }) {
  const routeLocation = useLocation();
  const location = routeLocation.state?.backgroundLocation || routeLocation;
  const navigate = useNavigate();
  const [activeHomeHash, setActiveHomeHash] = useState("");
  const tripRef = useRef(null);
  const locationRef = useRef(routeLocation);
  const intentRef = useRef("");
  const alignmentCleanupRef = useRef(null);
  const clickAlignedHashRef = useRef("");
  const pendingRouteRef = useRef(false);

  useIsomorphicLayoutEffect(() => {
    locationRef.current = routeLocation;
    pendingRouteRef.current = false;
  }, [location, routeLocation]);

  const finishSectionTrip = useCallback(() => {
    const trip = tripRef.current;
    if (!trip || trip.superseded) return;
    tripRef.current = null;
    clearTripEntry();
  }, []);

  const cancelAlignment = useCallback(() => {
    clickAlignedHashRef.current = "";
    if (alignmentCleanupRef.current) {
      alignmentCleanupRef.current();
      alignmentCleanupRef.current = null;
    }
  }, []);

  const stopAlignment = useCallback(() => {
    cancelAlignment();
    finishSectionTrip();
  }, [cancelAlignment, finishSectionTrip]);

  const alignTo = useCallback(
    (hash, options = {}) => {
      cancelAlignment();
      alignmentCleanupRef.current = alignToHashTarget({
        hash,
        behavior: "auto",
        getOffsetPx: getHeaderOffsetPx,
        stableFramesRequired: 8,
        preAlignStableFramesRequired: 8,
        maxWaitMs: 4200,
        minRuntimeMs: 0,
        observeMutations: true,
        ...options,
      });
    },
    [cancelAlignment]
  );

  const cancelSectionNavigation = useCallback((superseded = false) => {
    const trip = tripRef.current;
    tripRef.current = trip && superseded ? { ...trip, superseded } : null;
    if (trip && typeof window.history.state?.[SECTION_TRIP_ENTRY]?.key === "string") {
      const state = superseded
        ? { ...window.history.state, [SECTION_TRIP_ENTRY]: { key: trip.key, superseded } }
        : window.history.state;
      window.history.replaceState(state, "", trip.arrived ? window.location.href : trip.from);
    }
    intentRef.current = "";
    clearPendingSectionTarget();
    clearRouteTransitionIntent();
    document.documentElement.classList.remove("route-transition-out");
    window.dispatchEvent(new CustomEvent("roo:cancel-route-transition"));
    stopAlignment();
  }, [stopAlignment]);

  const supersedePendingNavigation = useCallback((hash = "") => {
    const committedLocation = locationRef.current;
    cancelSectionNavigation(true);
    const abandonedTrip = tripRef.current || window.history.state?.[SECTION_TRIP_ENTRY];
    const winningState = withoutSupersededSectionTrip(committedLocation.state, abandonedTrip);
    navigate(
      { pathname: committedLocation.pathname, search: committedLocation.search, hash },
      { replace: true, state: winningState }
    );
  }, [cancelSectionNavigation, navigate]);

  const goToSection = useCallback(
    (event, hash, alignment) => {
      if (!isPlainPrimaryClick(event)) return false;
      const normalizedHash = normalizeSectionHash(hash);
      if (!normalizedHash) return false;
      event.preventDefault();

      if (locationRef.current.pathname === "/" && !locationRef.current.state?.backgroundLocation) {
        if (pendingRouteRef.current) supersedePendingNavigation(normalizedHash);
        intentRef.current = "";
        clearPendingSectionTarget();
        const committedHome = locationRef.current;
        const search = sanitizeBrowserSearch(committedHome.pathname, committedHome.search);
        replaceBrowserUrl(normalizedHash, `${committedHome.pathname}${search}${normalizedHash}`);
        announceSectionTarget(normalizedHash);
        setActiveHomeHash(normalizedHash);
        alignTo(normalizedHash, alignment);
        clickAlignedHashRef.current = normalizedHash;
        return true;
      }

      intentRef.current = normalizedHash;
      writePendingSectionTarget(normalizedHash);
      writeRouteTransitionIntent(normalizedHash);
      document.documentElement.classList.add("route-transition-out");
      prefetchSectionData(normalizedHash);

      const nextHref = buildHomeSectionHref(normalizedHash);
      const trip = tripRef.current?.superseded ? null : tripRef.current;
      const {
        key = `section-${tripDocumentKey}-${++nextTripKey}`,
        via = routeShell === "memory"
          ? "memory"
          : window.location.pathname !== locationRef.current.pathname ? "document" : "router",
      } = trip || {};
      const state = { sectionTrip: key };
      if (!trip) {
        tripRef.current = {
          key, via, from: window.location.href, fromKey: locationRef.current.key,
        };
      }
      if (via === "document") {
        window.location.assign(nextHref);
        return true;
      }
      if (via === "memory") {
        if (trip) {
          replaceBrowserUrl("", nextHref);
        } else {
          const entry = window.history.state?.[SECTION_TRIP_ENTRY];
          const updateHistory = typeof entry?.key === "string" && entry.superseded ? "replaceState" : "pushState";
          window.history[updateHistory]({ ...window.history.state, [SECTION_TRIP_ENTRY]: { key } }, "", nextHref);
        }
      }
      navigate({ pathname: "/", hash: normalizedHash }, { replace: Boolean(trip), state });
      return true;
    },
    [alignTo, navigate, routeShell, supersedePendingNavigation]
  );

  const isOwnSectionArrival = useCallback(
    (target) =>
      Boolean(tripRef.current && !tripRef.current.superseded) &&
      target.state?.sectionTrip === tripRef.current.key,
    []
  );

  useIsomorphicLayoutEffect(() => {
    const trip = tripRef.current;
    if (isSupersededSectionTrip(location.state, trip)) {
      tripRef.current = null;
    } else if (trip) {
      const isTripArrival = location.state?.sectionTrip === trip.key;
      const isTripOrigin = location.key === trip.fromKey;
      if (isTripArrival) {
        trip.arrived = true;
        let task;
        const frame = window.requestAnimationFrame(() => {
          task = window.setTimeout(() => {
            if (tripRef.current === trip) finishSectionTrip();
          }, 0);
        });
        return () => {
          window.cancelAnimationFrame(frame);
          window.clearTimeout(task);
        };
      } else if (!isTripOrigin) {
        cancelSectionNavigation();
      }
    }
    if (location.pathname !== "/") stopAlignment();
  }, [cancelSectionNavigation, finishSectionTrip, location.key, location.pathname, location.state, stopAlignment]);

  useIsomorphicLayoutEffect(() => {
    const onTraversal = () => {
      tripRef.current = null;
      clearTripEntry();
      cancelSectionNavigation();
    };
    window.addEventListener("popstate", onTraversal);
    return () => {
      window.removeEventListener("popstate", onTraversal);
    };
  }, [cancelSectionNavigation]);

  useIsomorphicLayoutEffect(() => {
    const syncHash = () => {
      if (isSupersededSectionTrip(location.state, tripRef.current)) return;
      setActiveHomeHash(normalizeSectionHash(window.location.hash || location.hash));
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [location.hash, location.pathname, location.state]);

  useEffect(() => {
    const plainLink = (event) => {
      const link = event.target instanceof Element && event.target.closest("a[href]");
      return link && /^https?:$/.test(link.protocol) && !link.hasAttribute("download") &&
        isPlainPrimaryClick(event, link) && link;
    };
    const captureLinkIntent = (event) => {
      const link = plainLink(event);
      if (!link) return;
      if (link.getAttribute("href").startsWith("#")) {
        if (tripRef.current) {
          event.preventDefault();
          replaceBrowserUrl(link.hash, link.href);
          const target = document.getElementById(normalizeSectionHash(link.hash).slice(1));
          target?.focus({ preventScroll: true });
          target?.scrollIntoView();
        }
        return;
      }
      const homeSectionLink =
        link.origin === window.location.origin && link.pathname === "/" && isHomeSectionHash(link.hash);
      if (locationRef.current.pathname === "/" && link.href === `${window.location.origin}/`) {
        event.preventDefault();
        supersedePendingNavigation();
        if (window.location.hash) replaceBrowserUrl();
        setActiveHomeHash("");
        window.scrollTo(0, 0);
        return;
      }
      if (!homeSectionLink) {
        pendingRouteRef.current = true;
        cancelSectionNavigation(true);
      }
    };
    const endTripOnLink = (event) => {
      const link = tripRef.current?.superseded && plainLink(event);
      if (!link) return;
      const tripEntryPushed = window.history.state?.[SECTION_TRIP_ENTRY];
      if (typeof tripEntryPushed?.key === "string" && !link.getAttribute("href").startsWith("#")) {
        event.preventDefault();
        window.location.replace(link.href);
      }
    };
    const listeners = new AbortController();
    window.addEventListener("click", captureLinkIntent, { capture: true, signal: listeners.signal });
    window.addEventListener("click", endTripOnLink, { signal: listeners.signal });
    return () => listeners.abort();
  }, [cancelSectionNavigation, supersedePendingNavigation]);

  useIsomorphicLayoutEffect(() => {
    if (location.pathname !== "/") return;
    if (isSupersededSectionTrip(location.state, tripRef.current)) return;

    const intentHash = intentRef.current;
    intentRef.current = "";
    const urlHash = normalizeSectionHash(activeHomeHash);
    const pendingHash = readPendingSectionTarget();
    const targetHash = isHomeSectionHash(intentHash)
      ? intentHash
      : isHomeSectionHash(urlHash)
      ? urlHash
      : isHomeSectionHash(pendingHash)
      ? pendingHash
      : "";

    if (!targetHash) {
      stopAlignment();
      return;
    }

    const fromPending = targetHash === intentHash || targetHash === pendingHash;
    if (fromPending) {
      clearPendingSectionTarget();
    }

    if (window.location.hash !== targetHash) replaceBrowserUrl(targetHash);

    if (targetHash !== activeHomeHash) {
      setActiveHomeHash(targetHash);
    }

    if (targetHash === clickAlignedHashRef.current) return;

    alignTo(targetHash, {
      minRuntimeMs: fromPending ? 60 : 420,
      preAlignStableFramesRequired: fromPending ? 1 : 5,
    });
  }, [activeHomeHash, alignTo, location.pathname, location.state, stopAlignment]);

  useEffect(() => cancelSectionNavigation, [cancelSectionNavigation]);

  const actions = useMemo(
    () => ({ goToSection, isOwnSectionArrival }),
    [goToSection, isOwnSectionArrival]
  );

  return (
    <SectionNavigationContext.Provider value={actions}>
      <ActiveHomeSectionContext.Provider value={activeHomeHash}>
        {children}
      </ActiveHomeSectionContext.Provider>
    </SectionNavigationContext.Provider>
  );
}

export const useSectionNavigation = () => useContext(SectionNavigationContext);

export const useActiveHomeSection = () => useContext(ActiveHomeSectionContext);
