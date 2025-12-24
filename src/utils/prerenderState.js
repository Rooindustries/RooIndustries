// Shared helpers for react-snap state hydration.
export const isReactSnap = () =>
  typeof navigator !== "undefined" && navigator.userAgent === "ReactSnap";

export const getPreloadedState = (key) => {
  if (typeof window === "undefined") return undefined;
  const source = window.__PRELOADED_STATE__ || window.__SNAP_STATE__;
  if (!source || typeof source !== "object") return undefined;
  return Object.prototype.hasOwnProperty.call(source, key)
    ? source[key]
    : undefined;
};

export const setSnapState = (key, value) => {
  if (typeof window === "undefined") return;
  if (!window.__SNAP_STATE__) window.__SNAP_STATE__ = {};
  window.__SNAP_STATE__[key] = value;
};
