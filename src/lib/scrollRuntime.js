import { useSyncExternalStore } from "react";

const SCROLL_IDLE_MS = 160;

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
  const nextDirection =
    nextScrollY > snapshot.scrollY
      ? "down"
      : nextScrollY < snapshot.scrollY
      ? "up"
      : snapshot.direction;

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
    applyScrollingClass(false);
    setSnapshot({
      scrollY: getScrollY(),
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
