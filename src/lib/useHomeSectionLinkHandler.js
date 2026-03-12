import { useCallback, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import {
  HOME_SECTION_PREFETCH_BY_HASH,
  prefetchHomeSectionData,
  readHomeSectionData,
} from "./homeSectionData";
import { alignToHashTarget, getCssHeaderOffsetPx } from "./scrollCoordinator";
import {
  normalizeSectionHash,
  writePendingSectionTarget,
} from "./sectionNavigation";

export default function useHomeSectionLinkHandler() {
  const location = useLocation();
  const activeScrollCleanupRef = useRef(null);

  const runHashAlignment = useCallback((hash) => {
    const isPhone =
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches &&
      window.matchMedia("(pointer: coarse)").matches;

    if (activeScrollCleanupRef.current) {
      activeScrollCleanupRef.current();
    }

    activeScrollCleanupRef.current = alignToHashTarget({
      hash,
      behavior: "auto",
      getOffsetPx: () => getCssHeaderOffsetPx(110),
      stableFramesRequired: isPhone ? 4 : 8,
      preAlignStableFramesRequired: isPhone ? 0 : 5,
      minRuntimeMs: isPhone ? 0 : 900,
      maxWaitMs: isPhone ? 3200 : 4200,
      observeMutations: true,
    });
  }, []);

  useEffect(() => {
    return () => {
      if (activeScrollCleanupRef.current) {
        activeScrollCleanupRef.current();
        activeScrollCleanupRef.current = null;
      }
    };
  }, []);

  return useCallback(
    (event, hash) => {
      if (typeof window === "undefined") return;

      const normalizedHash = normalizeSectionHash(hash);
      if (!normalizedHash) return;

      writePendingSectionTarget(normalizedHash);

      const requiredKeys = HOME_SECTION_PREFETCH_BY_HASH[normalizedHash] || [];
      const missingKeys = requiredKeys.filter(
        (key) => readHomeSectionData(key) === null
      );

      if (missingKeys.length > 0) {
        prefetchHomeSectionData(missingKeys).catch(() => {});
      }

      if (location.pathname !== "/") {
        return;
      }

      if (event?.preventDefault) {
        event.preventDefault();
      }

      const nextUrl = `${window.location.pathname}${window.location.search}${normalizedHash}`;
      if (window.location.hash !== normalizedHash) {
        if (window.history?.replaceState) {
          window.history.replaceState(window.history.state, "", nextUrl);
        } else {
          window.location.hash = normalizedHash.slice(1);
        }
      }

      runHashAlignment(normalizedHash);
    },
    [location.pathname, runHashAlignment]
  );
}
