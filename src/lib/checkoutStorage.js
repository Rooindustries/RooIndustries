import { isKnownAdRefTag, normalizeLinkReferral } from "./refShape.js";

export const BOOKING_DRAFT_STORAGE_KEY = "booking_draft";
export const CHECKOUT_BOOKING_STORAGE_KEY = "checkout_booking_state";

const LEGACY_CHECKOUT_KEYS = "my_slot_hold,booking_draft,booking_modal_state,booking_form_prefill,referral_prefill_email,creatorId,referral,refLoginCode,refRememberMe".split(",");

const str = (v) => String(v || "").trim();
const isPlain = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export const readSessionJson = (k) => {
  if (typeof window === "undefined") return null;
  try { const p = JSON.parse(window.sessionStorage.getItem(k) || "null"); return isPlain(p) ? p : null; } catch { return null; }
};

const normalizePackage = (pkg = {}) => {
  const title = str(pkg?.title || pkg?.packageTitle);
  return title ? { title, price: str(pkg?.price || pkg?.packagePrice), tag: str(pkg?.tag || pkg?.packageTag) } : null;
};

export const persistBookingPackageSelection = (pkg) => {
  const selectedPackage = normalizePackage(pkg);
  if (!selectedPackage || typeof window === "undefined") return null;
  try {
    const parsed = { lastTitle: null, packages: {}, ...(readSessionJson(BOOKING_DRAFT_STORAGE_KEY) || {}) };
    parsed.packages = { ...(parsed.packages || {}), [selectedPackage.title]: { ...(parsed.packages?.[selectedPackage.title] || {}), selectedPackage } };
    parsed.lastTitle = selectedPackage.title;
    window.sessionStorage.setItem(BOOKING_DRAFT_STORAGE_KEY, JSON.stringify(parsed));
  } catch {}
  return selectedPackage;
};

export const readBookingPackageSelection = () => {
  const parsed = readSessionJson(BOOKING_DRAFT_STORAGE_KEY);
  return normalizePackage(parsed?.packages?.[parsed?.lastTitle]?.selectedPackage);
};

export const readStoredCheckoutBooking = () => readSessionJson(CHECKOUT_BOOKING_STORAGE_KEY);

export const writeStoredCheckoutBooking = (bookingData) => {
  if (typeof window === "undefined" || !isPlain(bookingData)) return null;
  try { window.sessionStorage.setItem(CHECKOUT_BOOKING_STORAGE_KEY, JSON.stringify(bookingData)); return bookingData; } catch { return null; }
};

export const extractTokenNonce = (t) => {
  const raw = str(t), h = raw.includes(".") ? raw.split(".")[0] : "";
  try {
    const b = h.replace(/-/g, "+").replace(/_/g, "/"), n = h && JSON.parse(atob(b + "=".repeat((4 - (b.length % 4)) % 4)))?.n;
    if (typeof n === "string" && n.trim()) return n.trim();
  } catch {}
  return raw;
};

export const updateStoredCheckoutHold = (hold = {}, scope = null) => {
  const current = readStoredCheckoutBooking();
  const slotHoldId = str(hold.slotHoldId), slotHoldToken = str(hold.slotHoldToken), slotHoldExpiresAt = str(hold.slotHoldExpiresAt);
  if (!current || !slotHoldId || !slotHoldToken || !slotHoldExpiresAt) return null;
  if (scope?.expectedHoldId && (str(current.slotHoldId) !== str(scope.expectedHoldId) ||
      (scope.expectedHoldNonce && extractTokenNonce(current.slotHoldToken) && extractTokenNonce(current.slotHoldToken) !== scope.expectedHoldNonce))) return null;
  return writeStoredCheckoutBooking({ ...current, slotHoldId, slotHoldToken, slotHoldExpiresAt });
};

export const migrateCheckoutStorageToSession = () => {
  if (typeof window === "undefined") return;
  let ls, ss;
  try { ls = window.localStorage; ss = window.sessionStorage; } catch { return; }
  for (const key of LEGACY_CHECKOUT_KEYS) {
    try {
      const v = ls.getItem(key);
      if (v !== null && ss.getItem(key) === null) ss.setItem(key, v);
      ls.removeItem(key);
    } catch {}
  }
};

export const stripReservedCode = (value) => {
  const code = str(value);
  return !code || isKnownAdRefTag(code) ? "" : code;
};
export const readLinkReferralFromSession = () => {
  try {
    return typeof window !== "undefined" ? normalizeLinkReferral(window.sessionStorage.getItem("referral_session") || "") : "";
  } catch {
    return "";
  }
};
