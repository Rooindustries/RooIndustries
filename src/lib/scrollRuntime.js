import { useSyncExternalStore } from "react";

const SCROLL_IDLE_MS = 160;

// Zone thresholds matching consumer usage:
// Navbar: scrollY > 8, scrollY > 12  |  BackButton: scrollY > 50
const getZone = (y) => {
  if (y <= 8) return 0;
  if (y <= 12) return 1;
  if (y <= 50) return 2;
  return 3;
};

const isLowPerf = () =>
  typeof document !== "undefined" &&
  document.documentElement.classList.contains("low-performance-mode");

let snapshot = {
  scrollY: 0,
  direction: "up",
  isScrolling: false,
};

const SERVER_SNAPSHOT = Object.freeze({
  scrollY: 0,
  direction: "up",
  isScrolling: false,
});

let cleanup = null;
let idleTimer = null;
let rafId = null;
let pendingScrollY = 0;
let lastRealScrollY = 0;
const listeners = new Set();

const emit = () => {
  listeners.forEach((listener) => listener());
};

const getScrollY = () => {
  if (typeof window === "undefined") return 0;
  return window.scrollY || window.pageYOffset || 0;
};

const applyScrollingClass = (active) => {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("is-scrolling", active);
};

const setSnapshot = (nextSnapshot) => {
  if (
    nextSnapshot.scrollY === snapshot.scrollY &&
    nextSnapshot.direction === snapshot.direction &&
    nextSnapshot.isScrolling === snapshot.isScrolling
  ) {
    return;
  }

  snapshot = nextSnapshot;
  emit();
};

const clearIdleTimer = () => {
  if (idleTimer) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }
};

const flushScrollFrame = () => {
  rafId = null;
  const nextScrollY = pendingScrollY;

  // Compute direction from actual previous position (not stale snapshot)
  const nextDirection =
    nextScrollY > lastRealScrollY
      ? "down"
      : nextScrollY < lastRealScrollY
      ? "up"
      : snapshot.direction;

  lastRealScrollY = nextScrollY;

  // In low-perf mode, skip emit if zone + direction unchanged
  // (consumers only check boolean thresholds, not exact scrollY)
  if (isLowPerf()) {
    const prevZone = getZone(snapshot.scrollY);
    const nextZone = getZone(nextScrollY);
    if (
      nextZone === prevZone &&
      nextDirection === snapshot.direction &&
      snapshot.isScrolling
    ) {
      return; // No consumer state would change — skip React reconciliation
    }
  }

  setSnapshot({
    scrollY: nextScrollY,
    direction: nextDirection,
    isScrolling: true,
  });
};

const handleScroll = () => {
  pendingScrollY = getScrollY();
  applyScrollingClass(true);
  if (rafId === null) {
    rafId = window.requestAnimationFrame(flushScrollFrame);
  }

  clearIdleTimer();
  idleTimer = window.setTimeout(() => {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    const finalScrollY = getScrollY();
    lastRealScrollY = finalScrollY;
    applyScrollingClass(false);
    setSnapshot({
      scrollY: finalScrollY,
      direction: snapshot.direction,
      isScrolling: false,
    });
  }, SCROLL_IDLE_MS);
};

const attach = () => {
  if (cleanup || typeof window === "undefined") return;

  snapshot = {
    scrollY: getScrollY(),
    direction: "up",
    isScrolling: false,
  };
  pendingScrollY = snapshot.scrollY;
  lastRealScrollY = snapshot.scrollY;

  window.addEventListener("scroll", handleScroll, { passive: true });

  cleanup = () => {
    window.removeEventListener("scroll", handleScroll);
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    clearIdleTimer();
    applyScrollingClass(false);
    cleanup = null;
  };
};

const detachIfUnused = () => {
  if (listeners.size > 0 || !cleanup) return;
  cleanup();
};

export const subscribeScrollRuntime = (listener) => {
  listeners.add(listener);
  attach();

  return () => {
    listeners.delete(listener);
    detachIfUnused();
  };
};

export const getScrollRuntimeSnapshot = () => snapshot;

export const useScrollRuntime = () =>
  useSyncExternalStore(
    subscribeScrollRuntime,
    getScrollRuntimeSnapshot,
    () => SERVER_SNAPSHOT
  );
