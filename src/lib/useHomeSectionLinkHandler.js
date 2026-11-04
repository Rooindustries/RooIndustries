import { useCallback } from "react";
import { useSectionNavigation } from "./sectionNavigator";

export default function useHomeSectionLinkHandler() {
  const { goToSection } = useSectionNavigation();

  return useCallback(
    (event, hash) => {
      const isPhone =
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 767px)").matches &&
        window.matchMedia("(pointer: coarse)").matches;

      return goToSection(event, hash, {
        scrollMode: isPhone ? "fast-smooth" : "instant",
        durationMs: isPhone ? 220 : undefined,
        stableFramesRequired: isPhone ? 1 : 8,
        preAlignStableFramesRequired: isPhone ? 1 : 5,
        minRuntimeMs: isPhone ? 0 : 900,
        maxWaitMs: isPhone ? 1200 : 4200,
      });
    },
    [goToSection]
  );
}
