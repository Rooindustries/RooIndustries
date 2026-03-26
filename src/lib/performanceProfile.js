import { useSyncExternalStore } from "react";

export const PERFORMANCE_PROFILE_EVENT = "roo-performance-mode-change";
export const PERFORMANCE_PROFILE_STORAGE_KEY = "roo-performance-profile";
export const PERFORMANCE_NOTICE_DISMISS_KEY =
  "roo-performance-notice-dismissed";
export const LEGACY_LITE_MODE_KEY = "roo-lite-mode";
export const LEGACY_LITE_MODE_MANUAL_KEY = "roo-lite-mode-manual";
export const LOW_PERFORMANCE_CLASS = "low-performance-mode";
export const REDUCED_EFFECTS_CLASS = "perf-reduced-effects-mode";
export const REDUCED_MOTION_CLASS = "perf-reduced-motion-mode";

export const PERFORMANCE_PROFILES = Object.freeze({
  FULL: "full",
  REDUCED: "reduced",
  LITE: "lite",
});

export const DEVICE_CLASSES = Object.freeze({
  DESKTOP: "desktop",
  MOBILE: "mobile",
  TABLET: "tablet",
});

const LITE_DECISION = Object.freeze({
  profile: PERFORMANCE_PROFILES.LITE,
  source: "forced",
  reason: "site-lite-only",
  deviceClass: DEVICE_CLASSES.DESKTOP,
  band: "unknown",
  expiresAt: null,
  renderer: "",
});

const createSnapshot = () => ({
  ...LITE_DECISION,
  prefersReducedMotion:
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
});

const SERVER_SNAPSHOT = Object.freeze({
  ...LITE_DECISION,
  prefersReducedMotion: false,
});

let currentSnapshot = SERVER_SNAPSHOT;
let initialized = false;
const subscribers = new Set();

const getDocumentElement = () =>
  typeof document !== "undefined" ? document.documentElement : null;

const syncRootClasses = (snapshot) => {
  const root = getDocumentElement();
  if (!root) return;
  root.classList.add(LOW_PERFORMANCE_CLASS);
  root.classList.remove(REDUCED_EFFECTS_CLASS);
  root.classList.toggle(REDUCED_MOTION_CLASS, snapshot.prefersReducedMotion);
};

const emitChange = () => {
  subscribers.forEach((listener) => listener());
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(PERFORMANCE_PROFILE_EVENT, {
        detail: currentSnapshot,
      })
    );
  }
};

const refreshSnapshot = () => {
  currentSnapshot = createSnapshot();
  syncRootClasses(currentSnapshot);
  return currentSnapshot;
};

export const getPerformanceProfileSnapshot = () =>
  typeof window === "undefined" ? SERVER_SNAPSHOT : currentSnapshot;

export const subscribePerformanceProfile = (listener) => {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
};

export const usePerformanceProfile = () =>
  useSyncExternalStore(
    subscribePerformanceProfile,
    getPerformanceProfileSnapshot,
    () => SERVER_SNAPSHOT
  );

export const isLowPerformanceModeEnabled = () => true;

export const isReducedEffectsModeEnabled = () => false;

export const useLowPerformanceMode = () =>
  useSyncExternalStore(
    subscribePerformanceProfile,
    () => true,
    () => true
  );

export const bootstrapPerformanceProfile = () => {
  if (typeof window === "undefined") {
    return SERVER_SNAPSHOT;
  }
  return refreshSnapshot();
};

export const initializePerformanceProfile = () => {
  if (typeof window === "undefined") {
    return SERVER_SNAPSHOT;
  }

  const snapshot = refreshSnapshot();
  if (!initialized) {
    initialized = true;
  }
  emitChange();
  return snapshot;
};

export const __applyPerformanceDecisionForTests = (decision = {}) => {
  currentSnapshot = {
    ...currentSnapshot,
    ...decision,
    profile: PERFORMANCE_PROFILES.LITE,
    source: "forced",
    reason: decision.reason || LITE_DECISION.reason,
  };
  syncRootClasses(currentSnapshot);
  emitChange();
};

export const __resetPerformanceProfileForTests = () => {
  initialized = false;
  currentSnapshot = SERVER_SNAPSHOT;
  const root = getDocumentElement();
  if (root) {
    root.classList.remove(LOW_PERFORMANCE_CLASS);
    root.classList.remove(REDUCED_EFFECTS_CLASS);
    root.classList.remove(REDUCED_MOTION_CLASS);
  }
};
