import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { HOME_SECTION_PREFETCH_BY_HASH, prefetchHomeSectionData, readHomeSectionData } from "./homeSectionData";
import { alignToHashTarget, getCssHeaderOffsetPx } from "./scrollCoordinator";
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
  writePendingSectionTarget,
  writeRouteTransitionIntent,
} from "./sectionNavigation";

const SectionNavigationContext = createContext(null);
const ActiveHomeSectionContext = createContext("");

const getHeaderOffsetPx = () => getCssHeaderOffsetPx(110);

const isPlainPrimaryClick = (event, link = event.currentTarget) =>
  !event.defaultPrevented &&
  !event.button &&
  !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) &&
  /^(_self)?$/.test(link.getAttribute("target") || "");

const replaceBrowserUrl = (hash = "", href = `${window.location.pathname}${window.location.search}${hash}`) =>
  window.history.replaceState(window.history.state, "", href);

const prefetchSectionData = (hash) => {
  const requiredKeys = HOME_SECTION_PREFETCH_BY_HASH[hash] || [];
  const missingKeys = requiredKeys.filter((key) => readHomeSectionData(key) === null);
  if (missingKeys.length > 0) {
    prefetchHomeSectionData(missingKeys).catch(() => {});
  }
};

export function SectionNavigationProvider({ routeShell = "browser", children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeHomeHash, setActiveHomeHash] = useState("");
  const tripRef = useRef(null);
  const locationRef = useRef(location);
  const intentRef = useRef("");
  const alignmentCleanupRef = useRef(null);
  const clickAlignedHashRef = useRef("");

  useLayoutEffect(() => {
    locationRef.current = location;
  }, [location]);

  const stopAlignment = useCallback(() => {
    clickAlignedHashRef.current = "";
    if (alignmentCleanupRef.current) {
      alignmentCleanupRef.current();
      alignmentCleanupRef.current = null;
    }
  }, []);

  const alignTo = useCallback(
    (hash, options = {}) => {
      stopAlignment();
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
    [stopAlignment]
  );

  const cancelSectionNavigation = useCallback((superseded = false) => {
    const trip = tripRef.current;
    tripRef.current = trip && superseded ? { ...trip, superseded } : null;
    if (trip && window.history.state?.[SECTION_TRIP_ENTRY]) {
      const state = superseded
        ? { ...window.history.state, [SECTION_TRIP_ENTRY]: { key: trip.key, superseded } }
        : window.history.state;
      window.history.replaceState(state, "", trip.from);
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
    const abandonedTrip = window.history.state?.[SECTION_TRIP_ENTRY];
    let winningState = committedLocation.state;
    if (isSupersededSectionTrip(winningState, abandonedTrip)) {
      winningState = { ...winningState };
      delete winningState.sectionTrip;
    }
    cancelSectionNavigation();
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

      if (locationRef.current.pathname === "/") {
        supersedePendingNavigation(normalizedHash);
        intentRef.current = "";
        clearPendingSectionTarget();
        if (window.location.hash !== normalizedHash) replaceBrowserUrl(normalizedHash);
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
        key = window.crypto.randomUUID(),
        via = routeShell === "memory"
          ? "memory"
          : window.location.pathname !== locationRef.current.pathname ? "document" : "router",
      } = trip || {};
      const state = { sectionTrip: key };
      if (!trip) {
        tripRef.current = { key, via, from: window.location.href, fromKey: locationRef.current.key };
      }
      if (via === "document") {
        window.location.assign(nextHref);
        return true;
      }
      if (via === "memory") {
        if (trip) {
          replaceBrowserUrl("", nextHref);
        } else {
          const updateHistory = window.history.state?.[SECTION_TRIP_ENTRY]?.superseded ? "replaceState" : "pushState";
          window.history[updateHistory]({ ...window.history.state, [SECTION_TRIP_ENTRY]: true }, "", nextHref);
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

  useEffect(() => {
    const trip = tripRef.current;
    if (isSupersededSectionTrip(location.state, trip)) return;
    if (trip) {
      const isTripArrival = location.state?.sectionTrip === trip.key;
      const isTripOrigin = location.key === trip.fromKey;
      if (isTripArrival) {
        tripRef.current = null;
      } else if (!isTripOrigin) {
        cancelSectionNavigation();
      }
    }
    if (location.pathname !== "/") stopAlignment();
  }, [cancelSectionNavigation, location.key, location.pathname, location.state, stopAlignment]);

  useEffect(() => {
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
      return link && !link.hasAttribute("download") && isPlainPrimaryClick(event, link) && link;
    };
    const captureLinkIntent = (event) => {
      const link = plainLink(event);
      if (!link) return;
      const homeSectionLink =
        link.origin === window.location.origin && link.pathname === "/" && isHomeSectionHash(link.hash);
      if (tripRef.current && !homeSectionLink) {
        cancelSectionNavigation(true);
        return;
      }
      if (locationRef.current.pathname !== "/" || link.href !== `${window.location.origin}/`) return;
      event.preventDefault();
      supersedePendingNavigation();
      if (window.location.hash) replaceBrowserUrl();
      setActiveHomeHash("");
      window.scrollTo(0, 0);
    };
    const endTripOnLink = (event) => {
      const link = tripRef.current?.superseded && plainLink(event);
      if (!link) return;
      const tripEntryPushed = window.history.state?.[SECTION_TRIP_ENTRY];
      if (tripEntryPushed && /^https?:$/.test(link.protocol) && !link.getAttribute("href").startsWith("#")) {
        event.preventDefault();
        window.location.replace(link.href);
      }
    };
    const listeners = new AbortController();
    window.addEventListener("click", captureLinkIntent, { capture: true, signal: listeners.signal });
    window.addEventListener("click", endTripOnLink, { signal: listeners.signal });
    return () => listeners.abort();
  }, [cancelSectionNavigation, supersedePendingNavigation]);

  useEffect(() => {
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
