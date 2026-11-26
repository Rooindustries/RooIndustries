import { sanitizeLandingSnapshot } from "./campaignSanitizer";
export const persistPendingArrival = (raw) => {
  const s = sanitizeLandingSnapshot(raw);
  if (!s || s.revisit || !Object.keys(s.campaign).length) return;
  let prevMs = NaN;
  try { prevMs = Date.parse(JSON.parse(sessionStorage.getItem("roo_pending_arrival_touch") || "null")?.capturedAt || ""); } catch {}
  try {
    if (!Number.isFinite(prevMs) || Date.parse(s.capturedAt) >= prevMs) sessionStorage.setItem("roo_pending_arrival_touch", JSON.stringify(s));
  } catch {}
};
