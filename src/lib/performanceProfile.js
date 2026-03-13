import { useSyncExternalStore } from "react";
import { isPerfDebugEnabled } from "./perfDebug";

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

const STORAGE_VERSION = 1;
const AUTO_DECISION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROBE_DURATION_MS = 5000;
const MIN_PROBE_FRAMES = 60;
const INTERACTION_IDLE_MS = 220;
const INTERACTION_IDLE_MAX_WAIT_MS = 1500;

const REDUCED_THRESHOLDS = Object.freeze({
  longFrameRatio: 18,
  severeFrames: 6,
  longTaskTotalMs: 250,
});

const LITE_THRESHOLDS = Object.freeze({
  longFrameRatio: 22,
  severeFrames: 10,
  longTaskTotalMs: 400,
});

const DIRECT_LITE_THRESHOLDS = Object.freeze({
  longFrameRatio: 30,
  severeFrames: 12,
  longTaskTotalMs: 650,
});

const RUNTIME_DOWNGRADE_REASONS = new Set([
  "runtime-degraded",
  "runtime-persistently-degraded",
  "runtime-severe-degradation",
]);

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

const HARD_WEAK_BAND_SIGNALS = new Set([
  "low-device-memory",
  "save-data",
  "entry-tier-mobile-gpu",
]);

const PROXY_WEAK_BAND_SIGNALS = new Set([
  "low-cpu-core-count",
  "high-dpr-memory-pressure",
]);

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

const PROBE_EVENTS = ["pointerdown", "keydown", "touchstart", "scroll"];
const IDLE_EVENTS = [
  "scroll",
  "wheel",
  "pointermove",
  "touchmove",
  "keydown",
];

let currentDecision = { ...DEFAULT_DECISION };
let subscribers = new Set();
let bootstrapComplete = false;
let initializationStarted = false;
let reducedMotionPreferred = false;
let reducedMotionCleanup = null;
let runtimeProbeCleanup = null;
let runtimeProbeStage = 0;
let runtimeProbeLocked = false;
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

export const getPerformanceBand = (snapshot) => {
  const weakSignals = [];
  const strongSignals = [];

  if (snapshot.deviceClass === DEVICE_CLASSES.DESKTOP) {
    return { band: "unknown", weakSignals, strongSignals };
  }

  if (snapshot.hardwareConcurrency !== null && snapshot.hardwareConcurrency <= 4) {
    weakSignals.push("low-cpu-core-count");
  }

  if (snapshot.deviceMemory !== null && snapshot.deviceMemory <= 3) {
    weakSignals.push("low-device-memory");
  }

  if (snapshot.saveData) {
    weakSignals.push("save-data");
  }

  if (
    snapshot.dpr >= 3 &&
    snapshot.deviceMemory !== null &&
    snapshot.deviceMemory <= 4
  ) {
    weakSignals.push("high-dpr-memory-pressure");
  }

  if (snapshot.rendererInfo?.family === "low") {
    weakSignals.push("entry-tier-mobile-gpu");
  }

  if (snapshot.deviceMemory !== null && snapshot.deviceMemory >= 6) {
    strongSignals.push("high-device-memory");
  }

  if (snapshot.hardwareConcurrency !== null && snapshot.hardwareConcurrency >= 8) {
    strongSignals.push("high-cpu-core-count");
  }

  if (snapshot.rendererInfo?.family === "high") {
    strongSignals.push("high-tier-mobile-gpu");
  }

  const hasHardWeakSignal = weakSignals.some((signal) =>
    HARD_WEAK_BAND_SIGNALS.has(signal)
  );
  const hasHighTierGpu = strongSignals.includes("high-tier-mobile-gpu");
  const nonProxyWeakSignals = weakSignals.filter(
    (signal) => !PROXY_WEAK_BAND_SIGNALS.has(signal)
  );

  // Treat high-tier mobile GPUs as more trustworthy than privacy-bucketed
  // CPU/DPR proxy signals. This prevents premium Android devices from falling
  // into low-end mode just because Chromium reported conservative buckets.
  if (hasHighTierGpu && !hasHardWeakSignal) {
    if (strongSignals.length >= 2 && nonProxyWeakSignals.length === 0) {
      return { band: "high", weakSignals, strongSignals };
    }

    if (nonProxyWeakSignals.length === 0) {
      return { band: "mid", weakSignals, strongSignals };
    }
  }

  if (weakSignals.length >= 2) {
    return { band: "low", weakSignals, strongSignals };
  }

  if (strongSignals.length >= 2 && weakSignals.length === 0) {
    return { band: "high", weakSignals, strongSignals };
  }

  return { band: "mid", weakSignals, strongSignals };
};

export const resolveHardFailDecision = (snapshot) => {
  const deviceClass = snapshot.deviceClass;
  const rendererInfo = snapshot.rendererInfo || {};

  if (deviceClass === DEVICE_CLASSES.DESKTOP && rendererInfo.checked) {
    if (rendererInfo.hasWebgl === false) {
      return {
        profile: PERFORMANCE_PROFILES.LITE,
        source: "auto",
        reason: "desktop-webgl-unavailable",
        deviceClass,
        band: "unknown",
        renderer: rendererInfo.renderer,
      };
    }
    if (rendererInfo.likelySoftware) {
      return {
        profile: PERFORMANCE_PROFILES.LITE,
        source: "auto",
        reason: "desktop-software-renderer",
        deviceClass,
        band: "unknown",
        renderer: rendererInfo.renderer,
      };
    }
  }

  if (
    deviceClass !== DEVICE_CLASSES.DESKTOP &&
    snapshot.deviceMemory !== null &&
    snapshot.deviceMemory <= 2
  ) {
    return {
      profile: PERFORMANCE_PROFILES.LITE,
      source: "auto",
      reason: "mobile-low-memory",
      deviceClass,
      band: "low",
      renderer: rendererInfo.renderer || "",
    };
  }

  if (deviceClass !== DEVICE_CLASSES.DESKTOP && rendererInfo.checked) {
    if (rendererInfo.hasWebgl === false) {
      return {
        profile: PERFORMANCE_PROFILES.LITE,
        source: "auto",
        reason: "mobile-webgl-unavailable",
        deviceClass,
        band: "low",
        renderer: rendererInfo.renderer,
      };
    }
    if (rendererInfo.likelySoftware) {
      return {
        profile: PERFORMANCE_PROFILES.LITE,
        source: "auto",
        reason: "mobile-software-renderer",
        deviceClass,
        band: "low",
        renderer: rendererInfo.renderer,
      };
    }
  }

  return null;
};

export const resolveInitialPerformanceDecision = (snapshot) => {
  const hardFailDecision = resolveHardFailDecision(snapshot);
  if (hardFailDecision) {
    return hardFailDecision;
  }

  if (snapshot.deviceClass === DEVICE_CLASSES.DESKTOP) {
    return {
      profile: PERFORMANCE_PROFILES.FULL,
      source: "default",
      reason: "desktop-hardware-renderer",
      deviceClass: snapshot.deviceClass,
      band: "unknown",
      renderer: snapshot.rendererInfo?.renderer || "",
    };
  }

  const bandInfo = getPerformanceBand(snapshot);
  if (bandInfo.band === "low") {
    return {
      profile: PERFORMANCE_PROFILES.REDUCED,
      source: "auto",
      reason: "mobile-low-end-heuristic",
      deviceClass: snapshot.deviceClass,
      band: bandInfo.band,
      renderer: snapshot.rendererInfo?.renderer || "",
    };
  }

  return {
    profile: PERFORMANCE_PROFILES.FULL,
    source: "default",
    reason:
      bandInfo.band === "high"
        ? "mobile-high-capability"
        : "mobile-balanced-default",
    deviceClass: snapshot.deviceClass,
    band: bandInfo.band,
    renderer: snapshot.rendererInfo?.renderer || "",
  };
};

export const buildDeviceSignature = (snapshot) => {
  const dprToken = snapshot.dpr ? Number(snapshot.dpr).toFixed(1) : "u";
  const gpuToken =
    snapshot.deviceClass === DEVICE_CLASSES.DESKTOP
      ? snapshot.rendererInfo?.checked
        ? snapshot.rendererInfo.hasWebgl === false
          ? "no-webgl"
          : snapshot.rendererInfo.likelySoftware
          ? "software"
          : "hardware"
        : "unknown"
      : "deferred";

  return [
    snapshot.deviceClass,
    snapshot.hardwareConcurrency ?? "u",
    snapshot.deviceMemory ?? "u",
    snapshot.saveData ? "sd1" : "sd0",
    dprToken,
    gpuToken,
  ].join("|");
};

const readStorageRecord = (storage, key) => {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const removeStorageKey = (storage, key) => {
  try {
    storage?.removeItem(key);
  } catch {}
};

export const readLegacyManualDecision = ({
  storage = isBrowser() ? window.localStorage : null,
  snapshot,
} = {}) => {
  if (!storage || !snapshot) return null;
  try {
    if (storage.getItem(LEGACY_LITE_MODE_MANUAL_KEY) !== "1") {
      return null;
    }

    // The legacy public Lite Mode toggle no longer exists. Only honor those
    // stale manual overrides when perf debug is explicitly enabled.
    if (!isPerfDebugEnabled()) {
      removeStorageKey(storage, LEGACY_LITE_MODE_MANUAL_KEY);
      removeStorageKey(storage, LEGACY_LITE_MODE_KEY);
      return null;
    }

    const storedMode = storage.getItem(LEGACY_LITE_MODE_KEY);
    if (storedMode === "on") {
      return {
        profile: PERFORMANCE_PROFILES.LITE,
        source: "manual",
        reason: "legacy-lite-manual-on",
        deviceClass: snapshot.deviceClass,
        band: snapshot.deviceClass === DEVICE_CLASSES.DESKTOP ? "unknown" : "low",
        renderer: snapshot.rendererInfo?.renderer || "",
      };
    }
    if (storedMode === "off") {
      return {
        profile: PERFORMANCE_PROFILES.FULL,
        source: "manual",
        reason: "legacy-lite-manual-off",
        deviceClass: snapshot.deviceClass,
        band: snapshot.deviceClass === DEVICE_CLASSES.DESKTOP ? "unknown" : "mid",
        renderer: snapshot.rendererInfo?.renderer || "",
      };
    }

    removeStorageKey(storage, LEGACY_LITE_MODE_MANUAL_KEY);
  } catch {}
  return null;
};

export const readStoredAutoDecision = ({
  storage = isBrowser() ? window.localStorage : null,
  snapshot,
  now = Date.now(),
} = {}) => {
  if (!storage || !snapshot) return null;

  const record = readStorageRecord(storage, PERFORMANCE_PROFILE_STORAGE_KEY);
  if (!record) return null;

  const expiresAt = Number(record.expiresAt);
  const recordSignature = String(record.deviceSignature || "");
  if (
    record.version !== STORAGE_VERSION ||
    !isValidProfile(record.profile) ||
    expiresAt <= now ||
    recordSignature !== buildDeviceSignature(snapshot)
  ) {
    removeStorageKey(storage, PERFORMANCE_PROFILE_STORAGE_KEY);
    return null;
  }

  const bandInfo =
    snapshot.deviceClass === DEVICE_CLASSES.DESKTOP
      ? { band: "unknown" }
      : getPerformanceBand(snapshot);
  const hardFailDecision =
    snapshot.deviceClass === DEVICE_CLASSES.DESKTOP
      ? null
      : resolveHardFailDecision(snapshot);

  // Mobile/tablet devices that are not currently low-band or hard-fail should
  // not get trapped in a persisted runtime-lite decision from a noisy sample.
  if (
    snapshot.deviceClass !== DEVICE_CLASSES.DESKTOP &&
    !hardFailDecision &&
    bandInfo.band !== "low" &&
    record.profile === PERFORMANCE_PROFILES.LITE &&
    RUNTIME_DOWNGRADE_REASONS.has(String(record.reason || ""))
  ) {
    removeStorageKey(storage, PERFORMANCE_PROFILE_STORAGE_KEY);
    return null;
  }

  return {
    profile: record.profile,
    source: "stored",
    reason: String(record.reason || "stored-auto-decision"),
    deviceClass: snapshot.deviceClass,
    band: bandInfo.band,
    expiresAt,
    renderer: snapshot.rendererInfo?.renderer || "",
  };
};

const persistAutoDecision = (decision, snapshot) => {
  if (!isBrowser()) return;
  if (
    decision.source === "manual" ||
    decision.source === "stored" ||
    decision.profile === PERFORMANCE_PROFILES.FULL
  ) {
    return;
  }

  const expiresAt = Date.now() + AUTO_DECISION_TTL_MS;
  try {
    window.localStorage.setItem(
      PERFORMANCE_PROFILE_STORAGE_KEY,
      JSON.stringify({
        version: STORAGE_VERSION,
        profile: decision.profile,
        source: "auto",
        reason: decision.reason,
        deviceSignature: buildDeviceSignature(snapshot),
        expiresAt,
      })
    );
  } catch {}

  setCurrentDecision({ ...decision, expiresAt });
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

  const mobileBootstrapSnapshot = collectPerformanceSnapshot({
    includeRenderer: false,
  });
  const snapshot =
    mobileBootstrapSnapshot.deviceClass === DEVICE_CLASSES.DESKTOP
      ? collectPerformanceSnapshot({ includeRenderer: true })
      : mobileBootstrapSnapshot;

  const manualDecision = readLegacyManualDecision({ snapshot });
  const storedDecision = readStoredAutoDecision({ snapshot });
  const bootstrapDecision =
    manualDecision ||
    storedDecision ||
    resolveHardFailDecision(snapshot) ||
    resolveInitialPerformanceDecision(snapshot);

  applyBootstrapDecision(bootstrapDecision);
  bootstrapComplete = true;
  return getPerformanceProfileSnapshot();
};

const scheduleIdleEvaluation = (callback) => {
  if (!isBrowser()) return;
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(callback, { timeout: 1200 });
    return;
  }
  window.setTimeout(callback, 300);
};

const thresholdMultiplierForBand = (band) => (band === "high" ? 1.15 : 1);

export const evaluateRuntimeMetrics = ({
  metrics,
  decision,
  stage = 0,
} = {}) => {
  if (!metrics || !decision) return null;
  if (decision.deviceClass === DEVICE_CLASSES.DESKTOP) return null;
  if (metrics.frames < MIN_PROBE_FRAMES) return null;

  const multiplier = thresholdMultiplierForBand(decision.band);
  const reducedThresholds = {
    longFrameRatio: REDUCED_THRESHOLDS.longFrameRatio * multiplier,
    severeFrames: REDUCED_THRESHOLDS.severeFrames * multiplier,
    longTaskTotalMs: REDUCED_THRESHOLDS.longTaskTotalMs * multiplier,
  };
  const liteThresholds = {
    longFrameRatio: LITE_THRESHOLDS.longFrameRatio * multiplier,
    severeFrames: LITE_THRESHOLDS.severeFrames * multiplier,
    longTaskTotalMs: LITE_THRESHOLDS.longTaskTotalMs * multiplier,
  };
  const directLiteThresholds = {
    longFrameRatio: DIRECT_LITE_THRESHOLDS.longFrameRatio * multiplier,
    severeFrames: DIRECT_LITE_THRESHOLDS.severeFrames * multiplier,
    longTaskTotalMs: DIRECT_LITE_THRESHOLDS.longTaskTotalMs * multiplier,
  };

  const breachesAny = (thresholds) =>
    metrics.longFrameRatio >= thresholds.longFrameRatio ||
    metrics.severeFrames >= thresholds.severeFrames ||
    metrics.longTaskTotalMs >= thresholds.longTaskTotalMs;

  const isHighBandMobile = decision.band === "high";

  if (
    stage === 0 &&
    !isHighBandMobile &&
    breachesAny(directLiteThresholds)
  ) {
    return {
      profile: PERFORMANCE_PROFILES.LITE,
      source: "auto",
      reason: "runtime-severe-degradation",
      deviceClass: decision.deviceClass,
      band: decision.band,
      renderer: decision.renderer || "",
    };
  }

  if (
    decision.profile === PERFORMANCE_PROFILES.FULL &&
    breachesAny(reducedThresholds)
  ) {
    return {
      profile: PERFORMANCE_PROFILES.REDUCED,
      source: "auto",
      reason: "runtime-degraded",
      deviceClass: decision.deviceClass,
      band: decision.band,
      renderer: decision.renderer || "",
    };
  }

  if (
    decision.profile === PERFORMANCE_PROFILES.REDUCED &&
    breachesAny(liteThresholds)
  ) {
    return {
      profile: PERFORMANCE_PROFILES.LITE,
      source: "auto",
      reason: "runtime-persistently-degraded",
      deviceClass: decision.deviceClass,
      band: decision.band,
      renderer: decision.renderer || "",
    };
  }

  return null;
};

const waitForInteractionIdle = (callback) => {
  if (!isBrowser()) {
    callback();
    return () => {};
  }

  let idleTimer = 0;
  let maxWaitTimer = 0;
  let complete = false;

  const cleanup = () => {
    IDLE_EVENTS.forEach((eventName) =>
      window.removeEventListener(eventName, schedule, true)
    );
    window.clearTimeout(idleTimer);
    window.clearTimeout(maxWaitTimer);
  };

  const finish = () => {
    if (complete) return;
    complete = true;
    cleanup();
    callback();
  };

  function schedule() {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(finish, INTERACTION_IDLE_MS);
  }

  IDLE_EVENTS.forEach((eventName) =>
    window.addEventListener(eventName, schedule, {
      passive: true,
      capture: true,
    })
  );

  maxWaitTimer = window.setTimeout(finish, INTERACTION_IDLE_MAX_WAIT_MS);
  schedule();

  return cleanup;
};

const collectRuntimeProbeMetrics = () =>
  new Promise((resolve) => {
    if (!isBrowser()) {
      resolve({
        frames: 0,
        longFrameRatio: 0,
        severeFrames: 0,
        longTaskTotalMs: 0,
      });
      return;
    }

    const frameDeltas = [];
    let longTaskTotalMs = 0;
    let lastFrameTs = performance.now();
    let rafId = 0;
    let longTaskObserver = null;

    const sampleFrame = (ts) => {
      const delta = ts - lastFrameTs;
      lastFrameTs = ts;
      if (delta > 0 && delta < 250) {
        frameDeltas.push(delta);
      }
      rafId = window.requestAnimationFrame(sampleFrame);
    };

    const finish = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      if (longTaskObserver) {
        longTaskObserver.disconnect();
      }

      const longFrames = frameDeltas.filter((delta) => delta > 24).length;
      const severeFrames = frameDeltas.filter((delta) => delta > 50).length;

      resolve({
        frames: frameDeltas.length,
        longFrameRatio: frameDeltas.length
          ? (longFrames / frameDeltas.length) * 100
          : 0,
        severeFrames,
        longTaskTotalMs,
      });
    };

    rafId = window.requestAnimationFrame(sampleFrame);

    if ("PerformanceObserver" in window) {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => {
            longTaskTotalMs += entry.duration || 0;
          });
        });
        longTaskObserver.observe({ type: "longtask", buffered: true });
      } catch {}
    }

    window.setTimeout(finish, PROBE_DURATION_MS);
  });

const stopRuntimeProbe = () => {
  if (runtimeProbeCleanup) {
    runtimeProbeCleanup();
    runtimeProbeCleanup = null;
  }
};

const finalizeAutoDecision = (decision, snapshot, onCommit) => {
  waitForInteractionIdle(() => {
    persistAutoDecision(decision, snapshot);
    onCommit?.();
  });
};

const startRuntimeProbeCycle = (baseDecision) => {
  if (!isBrowser() || runtimeProbeLocked) return;
  stopRuntimeProbe();

  const triggerProbe = async () => {
    stopRuntimeProbe();
    const refinedSnapshot = collectPerformanceSnapshot({ includeRenderer: true });
    const refinedDecision = resolveInitialPerformanceDecision(refinedSnapshot);

    if (refinedDecision.profile === PERFORMANCE_PROFILES.LITE) {
      runtimeProbeLocked = true;
      finalizeAutoDecision(refinedDecision, refinedSnapshot);
      return;
    }

    const effectiveDecision = {
      ...baseDecision,
      ...refinedDecision,
      renderer: refinedSnapshot.rendererInfo?.renderer || baseDecision.renderer,
      expiresAt: null,
    };
    setCurrentDecision(effectiveDecision);

    const metrics = await collectRuntimeProbeMetrics();
    const nextDecision = evaluateRuntimeMetrics({
      metrics,
      decision: effectiveDecision,
      stage: runtimeProbeStage,
    });

    if (!nextDecision) {
      runtimeProbeLocked = true;
      return;
    }

    if (nextDecision.profile === PERFORMANCE_PROFILES.REDUCED) {
      finalizeAutoDecision(nextDecision, refinedSnapshot, () => {
        runtimeProbeStage = 1;
        startRuntimeProbeCycle(nextDecision);
      });
      return;
    }

    runtimeProbeLocked = true;
    finalizeAutoDecision(nextDecision, refinedSnapshot);
  };

  PROBE_EVENTS.forEach((eventName) =>
    window.addEventListener(eventName, triggerProbe, {
      once: true,
      passive: true,
      capture: true,
    })
  );

  runtimeProbeCleanup = () => {
    PROBE_EVENTS.forEach((eventName) =>
      window.removeEventListener(eventName, triggerProbe, true)
    );
  };
};

const maybeStartRuntimeProbe = (decision) => {
  if (
    !isBrowser() ||
    runtimeProbeLocked ||
    decision.profile === PERFORMANCE_PROFILES.LITE ||
    decision.deviceClass === DEVICE_CLASSES.DESKTOP ||
    decision.source === "manual" ||
    decision.source === "stored"
  ) {
    return;
  }

  runtimeProbeStage = 0;
  startRuntimeProbeCycle(decision);
};

export const initializePerformanceProfile = () => {
  if (!isBrowser()) return getPerformanceProfileSnapshot();
  attachReducedMotionListener();
  bootstrapPerformanceProfile();
  if (initializationStarted) {
    return getPerformanceProfileSnapshot();
  }

  initializationStarted = true;

  scheduleIdleEvaluation(() => {
    const mobileLoadSafeSnapshot = collectPerformanceSnapshot({
      includeRenderer: false,
    });
    const snapshot =
      mobileLoadSafeSnapshot.deviceClass === DEVICE_CLASSES.DESKTOP
        ? collectPerformanceSnapshot({
            includeRenderer: true,
          })
        : mobileLoadSafeSnapshot;

    const manualDecision = readLegacyManualDecision({ snapshot });
    if (manualDecision) {
      clearStoredAutoDecision();
      setCurrentDecision(manualDecision);
      runtimeProbeLocked = true;
      return;
    }

    const storedDecision = readStoredAutoDecision({ snapshot });
    if (storedDecision) {
      setCurrentDecision(storedDecision);
      runtimeProbeLocked = true;
      return;
    }

    const initialDecision = resolveInitialPerformanceDecision(snapshot);
    if (initialDecision.profile === PERFORMANCE_PROFILES.LITE) {
      finalizeAutoDecision(initialDecision, snapshot);
      runtimeProbeLocked = true;
      return;
    }

    setCurrentDecision(initialDecision);
    maybeStartRuntimeProbe(initialDecision);
  });

  return getPerformanceProfileSnapshot();
};

export const __applyPerformanceDecisionForTests = (decision) => {
  setCurrentDecision(decision);
};

export const __resetPerformanceProfileForTests = () => {
  stopRuntimeProbe();
  runtimeProbeStage = 0;
  runtimeProbeLocked = false;
  bootstrapComplete = false;
  initializationStarted = false;
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
