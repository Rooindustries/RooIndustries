import { useSyncExternalStore } from "react";

const PERFORMANCE_MODE_EVENT = "roo-performance-mode-change";
const LOW_PERFORMANCE_CLASS = "low-performance-mode";

export const isLowPerformanceModeEnabled = () => {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains(LOW_PERFORMANCE_CLASS);
};

export const subscribePerformanceMode = (listener) => {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleChange = () => listener();
  window.addEventListener(PERFORMANCE_MODE_EVENT, handleChange);
  return () => window.removeEventListener(PERFORMANCE_MODE_EVENT, handleChange);
};

export const useLowPerformanceMode = () =>
  useSyncExternalStore(
    subscribePerformanceMode,
    isLowPerformanceModeEnabled,
    () => false
  );
