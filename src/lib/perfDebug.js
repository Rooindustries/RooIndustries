export const PERF_DEBUG_STORAGE_KEY = "roo_perf_debug";
export const PERF_DEBUG_TOGGLES_KEY = "roo_perf_debug_toggles";
export const PERF_DEBUG_EVENT = "roo-perf-debug-change";

export const PERF_TOGGLE_KEYS = {
  NO_NAVBAR_BLUR: "noNavbarBlur",
  NO_BANNER_BLUR: "noBannerBlur",
  PAUSE_REVIEWS_AUTOPLAY: "pauseReviewsAutoplay",
  PAUSE_HOWITWORKS_VIDEOS: "pauseHowItWorksVideos",
  NO_GLOW_ANIMATIONS: "noGlowAnimations",
};

const TOGGLE_CLASS_MAP = {
  [PERF_TOGGLE_KEYS.NO_NAVBAR_BLUR]: "perf-no-navbar-blur",
  [PERF_TOGGLE_KEYS.NO_BANNER_BLUR]: "perf-no-banner-blur",
  [PERF_TOGGLE_KEYS.NO_GLOW_ANIMATIONS]: "perf-no-glow",
  [PERF_TOGGLE_KEYS.PAUSE_REVIEWS_AUTOPLAY]: "perf-pause-reviews",
  [PERF_TOGGLE_KEYS.PAUSE_HOWITWORKS_VIDEOS]: "perf-pause-howitworks",
};

const DEFAULT_TOGGLES = Object.freeze({
  [PERF_TOGGLE_KEYS.NO_NAVBAR_BLUR]: false,
  [PERF_TOGGLE_KEYS.NO_BANNER_BLUR]: false,
  [PERF_TOGGLE_KEYS.PAUSE_REVIEWS_AUTOPLAY]: false,
  [PERF_TOGGLE_KEYS.PAUSE_HOWITWORKS_VIDEOS]: false,
  [PERF_TOGGLE_KEYS.NO_GLOW_ANIMATIONS]: false,
});

const isBrowser = () =>
  typeof window !== "undefined" && typeof document !== "undefined";

const parseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const getQueryPerfDebug = () => {
  if (!isBrowser()) return false;
  const value = new URLSearchParams(window.location.search).get("perfdebug");
  return value === "1";
};

export const isPerfDebugEnabled = () => {
  if (!isBrowser()) return false;
  if (getQueryPerfDebug()) {
    localStorage.setItem(PERF_DEBUG_STORAGE_KEY, "1");
    return true;
  }
  return localStorage.getItem(PERF_DEBUG_STORAGE_KEY) === "1";
};

export const readPerfDebugToggles = () => {
  if (!isBrowser()) return { ...DEFAULT_TOGGLES };
  const parsed = parseJson(localStorage.getItem(PERF_DEBUG_TOGGLES_KEY) || "");
  return {
    ...DEFAULT_TOGGLES,
    ...(parsed && typeof parsed === "object" ? parsed : {}),
  };
};

const writePerfDebugToggles = (toggles) => {
  if (!isBrowser()) return;
  localStorage.setItem(PERF_DEBUG_TOGGLES_KEY, JSON.stringify(toggles));
};

export const dispatchPerfDebugChange = (detail = {}) => {
  if (!isBrowser()) return;
  window.dispatchEvent(new CustomEvent(PERF_DEBUG_EVENT, { detail }));
};

export const applyPerfDebugClasses = (toggles = readPerfDebugToggles()) => {
  if (!isBrowser()) return;
  const enabled = isPerfDebugEnabled();
  const root = document.documentElement;

  Object.values(TOGGLE_CLASS_MAP).forEach((className) => {
    root.classList.remove(className);
  });

  if (!enabled) return;

  Object.entries(TOGGLE_CLASS_MAP).forEach(([key, className]) => {
    if (toggles[key]) {
      root.classList.add(className);
    }
  });
};

export const syncPerfDebugFromEnvironment = () => {
  const enabled = isPerfDebugEnabled();
  const toggles = readPerfDebugToggles();
  applyPerfDebugClasses(toggles);
  return { enabled, toggles };
};

export const setPerfDebugEnabled = (enabled) => {
  if (!isBrowser()) return;
  if (enabled) {
    localStorage.setItem(PERF_DEBUG_STORAGE_KEY, "1");
  } else {
    localStorage.removeItem(PERF_DEBUG_STORAGE_KEY);
  }
  const toggles = readPerfDebugToggles();
  applyPerfDebugClasses(toggles);
  dispatchPerfDebugChange({ enabled, toggles });
};

export const getPerfToggleEnabled = (key) => {
  const toggles = readPerfDebugToggles();
  return Boolean(toggles[key]);
};

export const setPerfDebugToggle = (key, enabled) => {
  if (!isBrowser()) return;
  const toggles = {
    ...readPerfDebugToggles(),
    [key]: Boolean(enabled),
  };
  writePerfDebugToggles(toggles);
  applyPerfDebugClasses(toggles);
  dispatchPerfDebugChange({ enabled: isPerfDebugEnabled(), toggles });
};

export const subscribePerfDebugChanges = (callback) => {
  if (!isBrowser()) return () => {};
  const handler = (event) => callback?.(event?.detail || {});
  window.addEventListener(PERF_DEBUG_EVENT, handler);
  return () => window.removeEventListener(PERF_DEBUG_EVENT, handler);
};

