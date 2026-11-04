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
  writePendingSectionTarget,
  writeRouteTransitionIntent,
} from "./sectionNavigation";

const SectionNavigationContext = createContext(null);
const ActiveHomeSectionContext = createContext("");

const getHeaderOffsetPx = () => getCssHeaderOffsetPx(110);

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
  const tripTimeoutRef = useRef(null);
  const homeNavigationRef = useRef(null);
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

  const clearTripTimeout = useCallback(() => {
    if (tripTimeoutRef.current) {
      clearTimeout(tripTimeoutRef.current);
      tripTimeoutRef.current = null;
    }
  }, []);

  const cancelSectionNavigation = useCallback(() => {
    clearTripTimeout();
    homeNavigationRef.current = null;
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
  }, [clearTripTimeout, stopAlignment]);

  const goToSection = useCallback(
    (event, hash, alignment) => {
      if (typeof window === "undefined") return;
      const normalizedHash = normalizeSectionHash(hash);
      if (!normalizedHash) return;
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
        return;
      }

      const fromPath = location.pathname;
      const browserPath = window.location.pathname || "/";
      intentRef.current = normalizedHash;
      writePendingSectionTarget(normalizedHash);
      writeRouteTransitionIntent({ kind: "section", hash: normalizedHash, from: fromPath });
      document.documentElement.classList.add("route-transition-out");
      prefetchSectionData(normalizedHash);

      const nextHref = buildHomeSectionHref(normalizedHash);
      if (homeNavigationRef.current === "memory") {
        replaceBrowserUrl(nextHref, normalizedHash);
        return;
      }
      if (homeNavigationRef.current === "router") {
        navigate(nextHref, { replace: true });
        return;
      }
      if (homeNavigationRef.current === "document") {
        window.location.assign(nextHref);
        return;
      }

      clearTripTimeout();
      tripTimeoutRef.current = window.setTimeout(() => {
        tripTimeoutRef.current = null;
        if (routeShell === "memory") {
          homeNavigationRef.current = "memory";
          if (window.history?.pushState) {
            window.history.pushState(window.history.state, "", nextHref);
          } else {
            window.location.hash = normalizedHash.slice(1);
          }
          navigate("/");
          return;
        }
        if (browserPath !== fromPath) {
          homeNavigationRef.current = "document";
          window.location.assign(nextHref);
          return;
        }
        homeNavigationRef.current = "router";
        navigate(nextHref);
      }, 20);
    },
    [alignTo, clearTripTimeout, location.pathname, navigate, routeShell]
  );

  const goToHomeTop = useCallback(
    (event) => {
      cancelSectionNavigation();
      if (typeof window === "undefined" || location.pathname !== "/") return;
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
    },
    [cancelSectionNavigation, location.pathname]
  );

  const isOwnSectionArrival = useCallback(
    (pathname) => pathname === "/" && homeNavigationRef.current !== null,
    []
  );

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
    if (location.pathname !== "/") {
      stopAlignment();
      return;
    }
    homeNavigationRef.current = null;
    clearTripTimeout();
  }, [clearTripTimeout, location.hash, location.pathname, stopAlignment]);

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
    () => ({ goToSection, goToHomeTop, cancelSectionNavigation, isOwnSectionArrival }),
    [cancelSectionNavigation, goToHomeTop, goToSection, isOwnSectionArrival]
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
