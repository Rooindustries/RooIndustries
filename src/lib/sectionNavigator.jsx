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

const isPlainPrimaryClick = (event, link = event?.currentTarget) => {
  if (!event) return true;
  if (event.defaultPrevented) return false;
  if (typeof event.button === "number" && event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = link?.getAttribute?.("target");
  return !target || target === "_self";
};

const replaceBrowserUrl = (href, hash) => {
  if (window.history?.replaceState) {
    window.history.replaceState(window.history.state, "", href);
  } else {
    window.location.hash = hash.slice(1);
  }
};

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
    if (trip && typeof window !== "undefined" && window.history.state?.[SECTION_TRIP_ENTRY]) {
      window.history.replaceState(window.history.state, "", trip.from);
    }
    intentRef.current = "";
    clearPendingSectionTarget();
    clearRouteTransitionIntent();
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove("route-transition-out");
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("roo:cancel-route-transition"));
    }
    stopAlignment();
  }, [stopAlignment]);

  const goToSection = useCallback(
    (event, hash, alignment) => {
      if (typeof window === "undefined" || !isPlainPrimaryClick(event)) return false;
      const normalizedHash = normalizeSectionHash(hash);
      if (!normalizedHash) return false;
      event?.preventDefault?.();

      if (location.pathname === "/") {
        intentRef.current = "";
        clearPendingSectionTarget();
        if (window.location.hash !== normalizedHash) {
          replaceBrowserUrl(
            `${window.location.pathname}${window.location.search}${normalizedHash}`,
            normalizedHash
          );
        }
        announceSectionTarget(normalizedHash);
        setActiveHomeHash(normalizedHash);
        alignTo(normalizedHash, alignment);
        clickAlignedHashRef.current = normalizedHash;
        return true;
      }

      const fromPath = location.pathname;
      const browserPath = window.location.pathname || "/";
      intentRef.current = normalizedHash;
      writePendingSectionTarget(normalizedHash);
      writeRouteTransitionIntent({ kind: "section", hash: normalizedHash, from: fromPath });
      document.documentElement.classList.add("route-transition-out");
      prefetchSectionData(normalizedHash);

      const nextHref = buildHomeSectionHref(normalizedHash);
      const trip = tripRef.current;
      if (trip?.via === "memory") {
        replaceBrowserUrl(nextHref, normalizedHash);
        return true;
      }
      if (trip?.via === "router") {
        navigate(nextHref, { replace: true, state: { sectionTrip: trip.key } });
        return true;
      }
      if (trip?.via === "document") {
        window.location.assign(nextHref);
        return true;
      }

      const via = routeShell === "memory" ? "memory" : browserPath !== fromPath ? "document" : "router";
      tripRef.current = { key: location.key, via, from: `${browserPath}${window.location.search}${window.location.hash}` };
      const tripState = { sectionTrip: location.key };
      if (via === "memory") {
        window.history.pushState({ ...window.history.state, [SECTION_TRIP_ENTRY]: true }, "", nextHref);
        navigate("/", { state: tripState });
      } else if (via === "document") {
        window.location.assign(nextHref);
      } else {
        navigate(nextHref, { state: tripState });
      }
      return true;
    },
    [alignTo, location.key, location.pathname, navigate, routeShell]
  );

  const goToHomeTop = useCallback(
    (event) => {
      if (!isPlainPrimaryClick(event)) return false;
      cancelSectionNavigation();
      if (typeof window === "undefined" || location.pathname !== "/") return true;
      event?.preventDefault?.();
      if (window.location.hash && window.history?.replaceState) {
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}`
        );
      }
      setActiveHomeHash("");
      window.scrollTo({ top: 0, behavior: "auto" });
      return true;
    },
    [cancelSectionNavigation, location.pathname]
  );

  const isOwnSectionArrival = useCallback(
    (target) => Boolean(tripRef.current) && target?.state?.sectionTrip === tripRef.current.key,
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
    if (typeof window === "undefined") return undefined;
    const syncHash = () => {
      setActiveHomeHash(normalizeSectionHash(window.location.hash || location.hash || ""));
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [location.hash, location.pathname]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const endTripOnDocumentLink = (event) => {
      if (!tripRef.current || !(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      if (!link || link.hasAttribute("download") || !isPlainPrimaryClick(event, link)) return;
      const tripEntryPushed = Boolean(window.history.state?.[SECTION_TRIP_ENTRY]);
      cancelSectionNavigation();
      if (tripEntryPushed && /^https?:$/.test(link.protocol) && !link.getAttribute("href").startsWith("#")) {
        event.preventDefault();
        window.location.replace(link.href);
      }
    };
    window.addEventListener("click", endTripOnDocumentLink);
    return () => window.removeEventListener("click", endTripOnDocumentLink);
  }, [cancelSectionNavigation]);

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

    if (window.location.hash !== targetHash && window.history?.replaceState) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}${targetHash}`
      );
    }

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
    () => ({ goToSection, goToHomeTop, isOwnSectionArrival }),
    [goToHomeTop, goToSection, isOwnSectionArrival]
  );

  return (
    <SectionNavigationContext.Provider value={actions}>
      <ActiveHomeSectionContext.Provider value={activeHomeHash}>
        {children}
      </ActiveHomeSectionContext.Provider>
    </SectionNavigationContext.Provider>
  );
}

export const useSectionNavigation = () => {
  const actions = useContext(SectionNavigationContext);
  if (!actions) {
    throw new Error("Section navigation needs a SectionNavigationProvider.");
  }
  return actions;
};

export const useActiveHomeSection = () => useContext(ActiveHomeSectionContext);
