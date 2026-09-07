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

const SOFTWARE_RENDERER_PATTERNS = [
  /swiftshader/i,
  /software/i,
  /llvmpipe/i,
  /basic render/i,
  /mesa offscreen/i,
];

const LOW_END_RENDERER_PATTERNS = [
  /adreno[^\d]{0,16}3\d\d/i,
  /adreno[^\d]{0,16}4\d\d/i,
  /mali-4/i,
  /mali-t/i,
  /powervr/i,
];

const HIGH_END_RENDERER_PATTERNS = [
  /apple gpu/i,
  /adreno[^\d]{0,16}7\d\d/i,
  /adreno[^\d]{0,16}8\d\d/i,
  /mali-g7\d/i,
  /mali-g8\d/i,
  /xclipse/i,
];

const DEFAULT_DECISION = Object.freeze({
  profile: PERFORMANCE_PROFILES.FULL,
  source: "default",
  reason: "initial",
  deviceClass: DEVICE_CLASSES.DESKTOP,
  band: "unknown",
  expiresAt: null,
  renderer: "",
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
  a.reason === b.reason &&
  a.deviceClass === b.deviceClass &&
  a.band === b.band &&
  a.expiresAt === b.expiresAt &&
  a.renderer === b.renderer;

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

const normalizeNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const getUserAgentDataMobile = (nav) => {
  const value = nav?.userAgentData?.mobile;
  return typeof value === "boolean" ? value : null;
};

export const resolveDeviceClass = (inputs = {}) => {
  const userAgent = String(inputs.userAgent || "").toLowerCase();
  const platform = String(inputs.platform || "").toLowerCase();
  const maxTouchPoints = Number(inputs.maxTouchPoints || 0);
  const userAgentDataMobile =
    typeof inputs.userAgentDataMobile === "boolean"
      ? inputs.userAgentDataMobile
      : null;

  if (platform === "macintel" && maxTouchPoints > 1) {
    return DEVICE_CLASSES.TABLET;
  }

  if (
    /ipad|tablet|playbook|silk/i.test(userAgent) ||
    (/android/i.test(userAgent) && !/mobile/i.test(userAgent))
  ) {
    return DEVICE_CLASSES.TABLET;
  }

  if (userAgentDataMobile === true) {
    return DEVICE_CLASSES.MOBILE;
  }

  if (
    /iphone|ipod|windows phone|iemobile|mobile/i.test(userAgent) ||
    /android.+mobile/i.test(userAgent)
  ) {
    return DEVICE_CLASSES.MOBILE;
  }

  return DEVICE_CLASSES.DESKTOP;
};

const classifyRendererFamily = (renderer = "") => {
  if (!renderer) return "unknown";
  if (LOW_END_RENDERER_PATTERNS.some((pattern) => pattern.test(renderer))) {
    return "low";
  }
  if (HIGH_END_RENDERER_PATTERNS.some((pattern) => pattern.test(renderer))) {
    return "high";
  }
  return "unknown";
};

export const detectRendererInfo = ({
  documentObject = typeof document !== "undefined" ? document : null,
} = {}) => {
  if (!documentObject?.createElement) {
    return {
      checked: false,
      hasWebgl: null,
      likelySoftware: false,
      renderer: "",
      family: "unknown",
    };
  }

  const canvas = documentObject.createElement("canvas");
  const gl =
    canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ||
    canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true }) ||
    canvas.getContext("experimental-webgl", {
      failIfMajorPerformanceCaveat: true,
    });

  if (!gl) {
    return {
      checked: true,
      hasWebgl: false,
      likelySoftware: true,
      renderer: "WebGL unavailable",
      family: "unknown",
    };
  }

  let renderer = "";
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (debugInfo) {
    renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "";
  }
  if (!renderer) {
    renderer = gl.getParameter(gl.RENDERER) || "";
  }

  return {
    checked: true,
    hasWebgl: true,
    likelySoftware: SOFTWARE_RENDERER_PATTERNS.some((pattern) =>
      pattern.test(renderer)
    ),
    renderer,
    family: classifyRendererFamily(renderer),
  };
};

export const collectPerformanceSnapshot = ({
  includeRenderer = false,
} = {}) => {
  if (!isBrowser()) {
    return {
      userAgent: "",
      platform: "",
      maxTouchPoints: 0,
      userAgentDataMobile: null,
      hardwareConcurrency: null,
      deviceMemory: null,
      dpr: 1,
      saveData: false,
      prefersReducedMotion: false,
      deviceClass: DEVICE_CLASSES.DESKTOP,
      rendererInfo: {
        checked: false,
        hasWebgl: null,
        likelySoftware: false,
        renderer: "",
        family: "unknown",
      },
    };
  }

  const nav = window.navigator || {};
  const userAgent = String(nav.userAgent || "");
  const platform = String(nav.platform || "");
  const maxTouchPoints = Number(nav.maxTouchPoints || 0);
  const userAgentDataMobile = getUserAgentDataMobile(nav);
  const hardwareConcurrency = normalizeNumber(nav.hardwareConcurrency);
  const deviceMemory = normalizeNumber(nav.deviceMemory);
  const dpr = normalizeNumber(window.devicePixelRatio) || 1;
  const saveData = Boolean(nav.connection?.saveData);
  const prefersReducedMotion = Boolean(
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
  );
  const deviceClass = resolveDeviceClass({
    userAgent,
    platform,
    maxTouchPoints,
    userAgentDataMobile,
  });

  return {
    userAgent,
    platform,
    maxTouchPoints,
    userAgentDataMobile,
    hardwareConcurrency,
    deviceMemory,
    dpr,
    saveData,
    prefersReducedMotion,
    deviceClass,
    rendererInfo: includeRenderer
      ? detectRendererInfo()
      : {
          checked: false,
          hasWebgl: null,
          likelySoftware: false,
          renderer: "",
          family: "unknown",
        },
  };
};

export const resolveInitialPerformanceDecision = (snapshot) => {
  return {
    profile: PERFORMANCE_PROFILES.LITE,
    source: "auto",
    reason: "default-lite-mode",
    deviceClass: snapshot.deviceClass,
    band: "unknown",
    renderer: snapshot.rendererInfo?.renderer || "",
  };
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
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", onChange);
    reducedMotionCleanup = () => mediaQuery.removeEventListener("change", onChange);
    return;
  }

  mediaQuery.addListener(onChange);
  reducedMotionCleanup = () => mediaQuery.removeListener(onChange);
};

export const bootstrapPerformanceProfile = () => {
  if (!isBrowser()) return getPerformanceProfileSnapshot();
  attachReducedMotionListener();
  if (bootstrapComplete) {
    applyRootClasses(currentDecision);
    return getPerformanceProfileSnapshot();
  }

  const snapshot = collectPerformanceSnapshot({ includeRenderer: false });
  const bootstrapDecision = resolveInitialPerformanceDecision(snapshot);

  applyBootstrapDecision(bootstrapDecision);
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
