import { useSyncExternalStore } from "react";

const SCROLL_IDLE_MS = 160;

const navbarScrollZone = (y) => {
  if (y <= 8) return 0;
  if (y <= 12) return 1;
  return 2;
};

const isLowPerf = () =>
  typeof document !== "undefined" &&
  document.documentElement.classList.contains("low-performance-mode");

let snapshot = {
  scrollY: 0,
  isScrolling: false,
};

const SERVER_SNAPSHOT = Object.freeze({
  scrollY: 0,
  isScrolling: false,
});

let cleanup = null;
let idleTimer = null;
let rafId = null;
let pendingScrollY = 0;
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

  // Low-performance consumers use thresholds, not exact scroll positions.
  if (isLowPerf()) {
    const prevZone = navbarScrollZone(snapshot.scrollY);
    const nextZone = navbarScrollZone(nextScrollY);
    if (nextZone === prevZone && snapshot.isScrolling) {
      return;
    }
  }

  setSnapshot({
    scrollY: nextScrollY,
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
    applyScrollingClass(false);
    setSnapshot({
      scrollY: finalScrollY,
      isScrolling: false,
    });
  }, SCROLL_IDLE_MS);
};

const attach = () => {
  if (cleanup || typeof window === "undefined") return;

  snapshot = {
    scrollY: getScrollY(),
    isScrolling: false,
  };
  pendingScrollY = snapshot.scrollY;

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
