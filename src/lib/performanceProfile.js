import { useSyncExternalStore } from "react";
import { onMediaChange } from "./mediaQuery";

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

const DEFAULT_DECISION = Object.freeze({
  profile: PERFORMANCE_PROFILES.FULL,
  source: "default",
  reason: "initial",
});

const SERVER_PERFORMANCE_PROFILE_SNAPSHOT = Object.freeze({
  ...DEFAULT_DECISION,
  prefersReducedMotion: false,
});

let currentDecision = { ...DEFAULT_DECISION };
let subscribers = new Set();
let bootstrapComplete = false;
let reducedMotionPreferred = false;
let reducedMotionCleanup = null;
let currentSnapshot = {
  ...DEFAULT_DECISION,
  prefersReducedMotion: false,
};

const isBrowser = () =>
  typeof window !== "undefined" && typeof document !== "undefined";

const isValidProfile = (value) =>
  value === PERFORMANCE_PROFILES.FULL ||
  value === PERFORMANCE_PROFILES.REDUCED ||
  value === PERFORMANCE_PROFILES.LITE;

const sanitizeDecision = (decision = {}) => ({
  ...DEFAULT_DECISION,
  ...decision,
  profile: isValidProfile(decision.profile)
    ? decision.profile
    : DEFAULT_DECISION.profile,
});

const areDecisionsEqual = (a, b) =>
  a.profile === b.profile &&
  a.source === b.source &&
  a.reason === b.reason;

const getDocumentElement = () =>
  typeof document !== "undefined" ? document.documentElement : null;

const applyRootClasses = (decision) => {
  const root = getDocumentElement();
  if (!root) return;
  root.classList.toggle(
    LOW_PERFORMANCE_CLASS,
    decision.profile === PERFORMANCE_PROFILES.LITE
  );
  root.classList.toggle(
    REDUCED_EFFECTS_CLASS,
    decision.profile === PERFORMANCE_PROFILES.REDUCED
  );
  root.classList.toggle(REDUCED_MOTION_CLASS, reducedMotionPreferred);
};

const emitDecisionChange = () => {
  subscribers.forEach((listener) => listener());
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(PERFORMANCE_PROFILE_EVENT, {
        detail: getPerformanceProfileSnapshot(),
      })
    );
  }
};

const syncCurrentSnapshot = () => {
  currentSnapshot = {
    ...currentDecision,
    prefersReducedMotion: reducedMotionPreferred,
  };
};

const setCurrentDecision = (decision, { emit = true } = {}) => {
  const nextDecision = sanitizeDecision(decision);
  const changed = !areDecisionsEqual(currentDecision, nextDecision);
  currentDecision = nextDecision;
  syncCurrentSnapshot();
  applyRootClasses(nextDecision);
  if (changed && emit) {
    emitDecisionChange();
  }
  if (!changed) {
    applyRootClasses(nextDecision);
  }
};

const removeStorageKey = (storage, key) => {
  try {
    storage?.removeItem(key);
  } catch {}
};

const clearStoredAutoDecision = () => {
  if (!isBrowser()) return;
  removeStorageKey(window.localStorage, PERFORMANCE_PROFILE_STORAGE_KEY);
};

export const getPerformanceProfileSnapshot = () => currentSnapshot;

export const subscribePerformanceProfile = (listener) => {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
};

export const usePerformanceProfile = () =>
  useSyncExternalStore(
    subscribePerformanceProfile,
    getPerformanceProfileSnapshot,
    () => SERVER_PERFORMANCE_PROFILE_SNAPSHOT
  );

export const isLowPerformanceModeEnabled = () =>
  getPerformanceProfileSnapshot().profile === PERFORMANCE_PROFILES.LITE;

export const isReducedEffectsModeEnabled = () => {
  const snapshot = getPerformanceProfileSnapshot();
  return (
    snapshot.profile === PERFORMANCE_PROFILES.REDUCED ||
    snapshot.profile === PERFORMANCE_PROFILES.LITE ||
    snapshot.prefersReducedMotion
  );
};

export const useLowPerformanceMode = () =>
  useSyncExternalStore(
    subscribePerformanceProfile,
    () => isLowPerformanceModeEnabled(),
    () => false
  );

const applyBootstrapDecision = (decision) => {
  setCurrentDecision(decision, { emit: false });
};

const syncReducedMotionPreference = ({ emit = true } = {}) => {
  if (!isBrowser() || !window.matchMedia) return;
  const nextValue = Boolean(
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  if (nextValue === reducedMotionPreferred) {
    applyRootClasses(currentDecision);
    return;
  }
  reducedMotionPreferred = nextValue;
  syncCurrentSnapshot();
  applyRootClasses(currentDecision);
  if (emit) {
    emitDecisionChange();
  }
};

const attachReducedMotionListener = () => {
  if (!isBrowser() || reducedMotionCleanup || !window.matchMedia) return;
  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onChange = () => syncReducedMotionPreference();

  syncReducedMotionPreference({ emit: false });
  reducedMotionCleanup = onMediaChange(mediaQuery, onChange);
};

export const bootstrapPerformanceProfile = () => {
  if (!isBrowser()) return getPerformanceProfileSnapshot();
  attachReducedMotionListener();
  if (bootstrapComplete) {
    applyRootClasses(currentDecision);
    return getPerformanceProfileSnapshot();
  }

  applyBootstrapDecision({
    profile: PERFORMANCE_PROFILES.LITE,
    source: "auto",
    reason: "default-lite-mode",
  });
  bootstrapComplete = true;
  return getPerformanceProfileSnapshot();
};

export const initializePerformanceProfile = () => {
  if (!isBrowser()) return getPerformanceProfileSnapshot();
  attachReducedMotionListener();
  bootstrapPerformanceProfile();
  return getPerformanceProfileSnapshot();
};

export const __applyPerformanceDecisionForTests = (decision) => {
  setCurrentDecision(decision);
};

export const __resetPerformanceProfileForTests = () => {
  bootstrapComplete = false;
  reducedMotionPreferred = false;
  subscribers = new Set();
  if (reducedMotionCleanup) {
    reducedMotionCleanup();
    reducedMotionCleanup = null;
  }
  currentDecision = { ...DEFAULT_DECISION };
  syncCurrentSnapshot();
  applyRootClasses(currentDecision);
  if (isBrowser()) {
    clearStoredAutoDecision();
    removeStorageKey(window.localStorage, PERFORMANCE_NOTICE_DISMISS_KEY);
    removeStorageKey(window.localStorage, LEGACY_LITE_MODE_KEY);
    removeStorageKey(window.localStorage, LEGACY_LITE_MODE_MANUAL_KEY);
  }
};
