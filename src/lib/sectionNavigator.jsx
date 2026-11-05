import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { HOME_SECTION_PREFETCH_BY_HASH, prefetchHomeSectionData, readHomeSectionData } from "./homeSectionData";
import { alignToHashTarget, getCssHeaderOffsetPx } from "./scrollCoordinator";
import {
  announceSectionTarget,
  buildHomeSectionHref,
  clearPendingSectionTarget,
  clearRouteTransitionIntent,
  isHomeSectionHash,
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
  const intentRef = useRef("");
  const alignmentCleanupRef = useRef(null);
  const clickAlignedHashRef = useRef("");

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

  const cancelSectionNavigation = useCallback(() => {
    const trip = tripRef.current;
    tripRef.current = null;
    if (trip && window.history.state?.[SECTION_TRIP_ENTRY]) replaceBrowserUrl("", trip.from);
    intentRef.current = "";
    clearPendingSectionTarget();
    clearRouteTransitionIntent();
    document.documentElement.classList.remove("route-transition-out");
    window.dispatchEvent(new CustomEvent("roo:cancel-route-transition"));
    stopAlignment();
  }, [stopAlignment]);

  const goToSection = useCallback(
    (event, hash, alignment) => {
      if (!isPlainPrimaryClick(event)) return false;
      const normalizedHash = normalizeSectionHash(hash);
      if (!normalizedHash) return false;
      event.preventDefault();

      if (location.pathname === "/") {
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
      const trip = tripRef.current;
      const {
        key = location.key,
        via = routeShell === "memory" ? "memory" : window.location.pathname !== location.pathname ? "document" : "router",
      } = trip || {};
      const state = { sectionTrip: key };
      if (!trip) tripRef.current = { key, via, from: window.location.href };
      if (via === "document") {
        window.location.assign(nextHref);
      } else if (via === "router") {
        navigate(nextHref, { replace: Boolean(trip), state });
      } else if (trip) {
        replaceBrowserUrl("", nextHref);
      } else {
        window.history.pushState({ ...window.history.state, [SECTION_TRIP_ENTRY]: true }, "", nextHref);
        navigate("/", { state });
      }
      return true;
    },
    [alignTo, location.key, location.pathname, navigate, routeShell]
  );

  const isOwnSectionArrival = useCallback(
    (target) => Boolean(tripRef.current) && target.state?.sectionTrip === tripRef.current.key,
    []
  );

  useEffect(() => {
    const trip = tripRef.current;
    if (trip && trip.key !== location.key) {
      if (location.state?.sectionTrip === trip.key) {
        tripRef.current = null;
      } else {
        cancelSectionNavigation();
      }
    }
    if (location.pathname !== "/") stopAlignment();
  }, [cancelSectionNavigation, location.key, location.pathname, location.state, stopAlignment]);

  useEffect(() => {
    const syncHash = () => {
      setActiveHomeHash(normalizeSectionHash(window.location.hash || location.hash));
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [location.hash, location.pathname]);

  useEffect(() => {
    const plainLink = (event) => {
      const link = event.target instanceof Element && event.target.closest("a[href]");
      return link && !link.hasAttribute("download") && isPlainPrimaryClick(event, link) && link;
    };
    const goToHomeTop = (event) => {
      const link = location.pathname === "/" && plainLink(event);
      if (!link || link.href !== `${window.location.origin}/`) return;
      event.preventDefault();
      cancelSectionNavigation();
      if (window.location.hash) replaceBrowserUrl();
      setActiveHomeHash("");
      window.scrollTo(0, 0);
    };
    const endTripOnLink = (event) => {
      const link = tripRef.current && plainLink(event);
      if (!link) return;
      const tripEntryPushed = window.history.state?.[SECTION_TRIP_ENTRY];
      cancelSectionNavigation();
      if (tripEntryPushed && /^https?:$/.test(link.protocol) && !link.getAttribute("href").startsWith("#")) {
        event.preventDefault();
        window.location.replace(link.href);
      }
    };
    const listeners = new AbortController();
    window.addEventListener("click", goToHomeTop, { capture: true, signal: listeners.signal });
    window.addEventListener("click", endTripOnLink, { signal: listeners.signal });
    return () => listeners.abort();
  }, [cancelSectionNavigation, location.pathname]);

  useEffect(() => {
    if (location.pathname !== "/") return;

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
  }, [activeHomeHash, alignTo, location.pathname, stopAlignment]);

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
