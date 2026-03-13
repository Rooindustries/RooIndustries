import { normalizeSectionHash } from "./sectionNavigation";

const SCROLL_TOLERANCE_PX = 1;
const FAST_SMOOTH_DURATION_MS = 220;

const easeOutCubic = (value) => 1 - Math.pow(1 - value, 3);

const getHeaderOffset = () => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    "--header-offset"
  );
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

const setWindowScrollTop = (top) => {
  window.scrollTo({
    top: Math.max(0, top),
    behavior: "auto",
  });
};

export const getCssHeaderOffsetPx = (fallback = 110) => {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallback;
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    "--section-nav-offset"
  );
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed + 12 : fallback;
};

export const alignToHashTarget = ({
  hash,
  behavior = "auto",
  scrollMode,
  durationMs = FAST_SMOOTH_DURATION_MS,
  getOffsetPx = () => getCssHeaderOffsetPx(),
  stableFramesRequired = 8,
  preAlignStableFramesRequired = 8,
  minRuntimeMs = 0,
  maxWaitMs = 4200,
  observeMutations = true,
} = {}) => {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  const normalizedHash = normalizeSectionHash(hash);
  if (!normalizedHash) return () => {};

  const targetId = normalizedHash.slice(1);
  if (!targetId) return () => {};
  const resolvedScrollMode =
    scrollMode || (behavior === "smooth" ? "fast-smooth" : "instant");
  const root = document.documentElement;
  const previousRootScrollBehavior = root.style.scrollBehavior;

  root.style.scrollBehavior = "auto";

  const notifySettled = () => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("roo:section-align-settled", {
        detail: { hash: normalizedHash },
      })
    );
  };

  let rafId = 0;
  let animationRafId = 0;
  let cancelled = false;
  let finished = false;
  const startTs = performance.now();
  const deadline = startTs + maxWaitMs;
  let stableFrames = 0;
  let preAlignStableFrames = 0;
  let firstAlign = true;
  let observer = null;
  let resizeObserver = null;
  let observedTarget = null;
  let resizeTimeout = null;
  let resizeHandler = null;
  let lastDocumentTop = null;
  let lastHeaderOffset = null;
  let userIntentHandler = null;
  let activeAnimation = null;

  const teardownUserIntent = () => {
    if (!userIntentHandler) return;
    window.removeEventListener("wheel", userIntentHandler);
    window.removeEventListener("touchmove", userIntentHandler);
    window.removeEventListener("keydown", userIntentHandler);
    userIntentHandler = null;
  };

  const markUnstable = () => {
    stableFrames = 0;
    preAlignStableFrames = 0;
  };

  const cancelAnimation = () => {
    activeAnimation = null;
    if (!animationRafId) return;
    window.cancelAnimationFrame(animationRafId);
    animationRafId = 0;
  };

  const restoreRootScrollBehavior = () => {
    if (previousRootScrollBehavior) {
      root.style.scrollBehavior = previousRootScrollBehavior;
      return;
    }
    root.style.removeProperty("scroll-behavior");
  };

  const finish = ({ notify = true } = {}) => {
    if (finished) return;
    finished = true;
    cancelled = true;
    teardownUserIntent();
    cancelAnimation();
    if (rafId) {
      window.cancelAnimationFrame(rafId);
    }
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }
    if (observer) {
      observer.disconnect();
    }
    if (resizeObserver) {
      if (observedTarget) {
        resizeObserver.unobserve(observedTarget);
      }
      resizeObserver.disconnect();
    }
    if (resizeHandler) {
      window.removeEventListener("resize", resizeHandler);
    }
    restoreRootScrollBehavior();
    if (notify) {
      notifySettled();
    }
  };

  const animateTo = (targetTop) => {
    const fromTop = window.scrollY;
    const nextTop = Math.max(0, targetTop);

    if (Math.abs(nextTop - fromTop) <= SCROLL_TOLERANCE_PX) {
      setWindowScrollTop(nextTop);
      return;
    }

    cancelAnimation();

    const startTop = fromTop;
    const startAt = performance.now();
    activeAnimation = {
      targetTop: nextTop,
      startedAt: startAt,
    };

    const step = () => {
      if (cancelled || !activeAnimation) return;

      const elapsed = performance.now() - startAt;
      const progress = Math.min(1, elapsed / Math.max(1, durationMs));
      const eased = easeOutCubic(progress);
      const currentTop = startTop + (nextTop - startTop) * eased;

      setWindowScrollTop(currentTop);

      if (progress >= 1) {
        setWindowScrollTop(nextTop);
        activeAnimation = null;
        animationRafId = 0;
        return;
      }

      animationRafId = window.requestAnimationFrame(step);
    };

    animationRafId = window.requestAnimationFrame(step);
  };

  if (observeMutations && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => {
      markUnstable();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: false,
    });

    resizeHandler = () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        markUnstable();
      }, 50);
    };
    window.addEventListener("resize", resizeHandler, { passive: true });
  }

  if (observeMutations && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      markUnstable();
    });
    if (document.body) {
      resizeObserver.observe(document.body);
    }
  }

  userIntentHandler = (event) => {
    if (firstAlign) return;

    if (event?.type === "keydown") {
      const key = String(event.key || "");
      const scrollKeys = new Set([
        "ArrowDown",
        "ArrowUp",
        "PageDown",
        "PageUp",
        "Home",
        "End",
        " ",
      ]);
      if (!scrollKeys.has(key)) return;
    }

    finish({ notify: true });
  };

  window.addEventListener("wheel", userIntentHandler, { passive: true });
  window.addEventListener("touchmove", userIntentHandler, { passive: true });
  window.addEventListener("keydown", userIntentHandler);

  const tick = () => {
    if (cancelled) return;
    const now = performance.now();
    const el = document.getElementById(targetId);

    if (!el) {
      if (now < deadline) {
        rafId = window.requestAnimationFrame(tick);
      }
      return;
    }

    if (resizeObserver && observedTarget !== el) {
      if (observedTarget) {
        resizeObserver.unobserve(observedTarget);
      }
      observedTarget = el;
      resizeObserver.observe(el);
    }

    const desiredTop = getOffsetPx();
    const headerOffset = getHeaderOffset();
    const rectTop = el.getBoundingClientRect().top;
    const documentTop = rectTop + window.scrollY;
    const diff = rectTop - desiredTop;
    const geometryStable =
      (lastDocumentTop === null ||
        Math.abs(documentTop - lastDocumentTop) <= SCROLL_TOLERANCE_PX) &&
      (lastHeaderOffset === null ||
        Math.abs(headerOffset - lastHeaderOffset) <= SCROLL_TOLERANCE_PX);

    if (geometryStable) {
      preAlignStableFrames += 1;
    } else {
      preAlignStableFrames = 0;
      stableFrames = 0;
    }
    lastDocumentTop = documentTop;
    lastHeaderOffset = headerOffset;

    const readyToAlign =
      preAlignStableFrames >= preAlignStableFramesRequired;

    if (firstAlign && !readyToAlign) {
      rafId = window.requestAnimationFrame(tick);
      return;
    }

    if (Math.abs(diff) > SCROLL_TOLERANCE_PX) {
      const nextTop = window.scrollY + diff;
      if (resolvedScrollMode === "fast-smooth" && firstAlign) {
        if (!activeAnimation) {
          animateTo(nextTop);
        }
      } else if (!activeAnimation) {
        setWindowScrollTop(nextTop);
      }
      stableFrames = 0;
    } else if (!activeAnimation && geometryStable) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
    }

    firstAlign = false;

    const runtimeMs = performance.now() - startTs;
    const hitStability = stableFrames >= stableFramesRequired;

    if (runtimeMs >= minRuntimeMs && hitStability) {
      finish({ notify: true });
      return;
    }
    if (now >= deadline) {
      finish({ notify: true });
      return;
    }

    rafId = window.requestAnimationFrame(tick);
  };

  rafId = window.requestAnimationFrame(tick);

  return () => finish({ notify: false });
};
