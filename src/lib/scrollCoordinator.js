import { normalizeSectionHash } from "./sectionNavigation";

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

  const notifySettled = () => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("roo:section-align-settled", {
        detail: { hash: normalizedHash },
      })
    );
  };

  let rafId = 0;
  let cancelled = false;
  const startTs = performance.now();
  const deadline = startTs + maxWaitMs;
  let stableFrames = 0;
  let preAlignStableFrames = 0;
  let firstAlign = true;
  let mutationObserved = false;
  let observer = null;
  let resizeObserver = null;
  let observedTarget = null;
  let resizeTimeout = null;
  let resizeHandler = null;
  let lastDocumentTop = null;
  let lastHeaderOffset = null;
  let userIntentHandler = null;

  const teardownUserIntent = () => {
    if (!userIntentHandler) return;
    window.removeEventListener("wheel", userIntentHandler);
    window.removeEventListener("touchmove", userIntentHandler);
    window.removeEventListener("keydown", userIntentHandler);
    userIntentHandler = null;
  };

  const markUnstable = () => {
    mutationObserved = true;
    stableFrames = 0;
    preAlignStableFrames = 0;
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

    cancelled = true;
    teardownUserIntent();
    notifySettled();
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
    const headerOffset = (() => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(
        "--header-offset"
      );
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    })();
    const rectTop = el.getBoundingClientRect().top;
    const documentTop = rectTop + window.scrollY;
    const diff = rectTop - desiredTop;
    const headerStable =
      lastHeaderOffset === null || Math.abs(headerOffset - lastHeaderOffset) <= 1;

    if (
      (lastDocumentTop === null || Math.abs(documentTop - lastDocumentTop) <= 1) &&
      headerStable
    ) {
      preAlignStableFrames += 1;
    } else {
      preAlignStableFrames = 0;
      mutationObserved = true;
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

    if (Math.abs(diff) > 1) {
      mutationObserved = false;
      window.scrollTo({
        top: Math.max(0, window.scrollY + diff),
        behavior: firstAlign ? behavior : "auto",
      });
      stableFrames = 0;
    } else {
      stableFrames += 1;
    }

    firstAlign = false;

    const runtimeMs = now - startTs;
    const hitStability =
      stableFrames >= stableFramesRequired && !mutationObserved;

    if (runtimeMs >= minRuntimeMs && hitStability) {
      notifySettled();
      return;
    }
    if (now >= deadline) {
      notifySettled();
      return;
    }

    rafId = window.requestAnimationFrame(tick);
  };

  rafId = window.requestAnimationFrame(tick);

  return () => {
    cancelled = true;
    teardownUserIntent();
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
  };
};
