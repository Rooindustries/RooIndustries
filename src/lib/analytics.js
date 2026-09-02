import { track } from "@vercel/analytics/react";

const ensureAnalyticsQueue = () => {
  if (typeof window === "undefined" || window.va) return;
  window.va = (...args) => {
    window.vaq = window.vaq || [];
    window.vaq.push(args);
  };
};

export const trackEvent = (eventName, data = {}) => {
  try {
    ensureAnalyticsQueue();
    track(eventName, data);
  } catch {
    return;
  }
};
