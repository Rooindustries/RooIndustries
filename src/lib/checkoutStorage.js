import { readBrowserStorage, removeBrowserStorage, writeBrowserStorage } from "./browserStorage";

export const BOOKING_DRAFT_STORAGE_KEY = "booking_draft";
export const CHECKOUT_BOOKING_STORAGE_KEY = "checkout_booking_state";
export const BOOKING_HOLD_EXPIRED_STORAGE_KEY = "booking_hold_expired";
// A hold whose payment has started is never dropped by the browser after its deadline; payment status or a release settles it.
export const holdAwaitsPayment = (hold) => String(hold?.phase || "").trim().toLowerCase() === "payment_pending";
// The stored marker carries an expiry across reloads; the in-memory flag still protects the draft on this page
// when a full store refuses the marker. Write it after removing the hold so the freed space takes it.
let bookingHoldExpiredHere = false;
export const markBookingHoldExpired = () => {
  bookingHoldExpiredHere = true;
  return writeBrowserStorage("sessionStorage", BOOKING_HOLD_EXPIRED_STORAGE_KEY, "1");
};
export const clearBookingHoldExpired = () => {
  bookingHoldExpiredHere = false;
  return removeBrowserStorage("sessionStorage", BOOKING_HOLD_EXPIRED_STORAGE_KEY);
};
export const bookingHoldExpired = () =>
  bookingHoldExpiredHere || Boolean(readBrowserStorage("sessionStorage", BOOKING_HOLD_EXPIRED_STORAGE_KEY));

const LEGACY_CHECKOUT_KEYS = [
  "my_slot_hold",
  BOOKING_DRAFT_STORAGE_KEY,
  "booking_modal_state",
  "booking_form_prefill",
  "referral_prefill_email",
  "creatorId",
  "referral",
  "refLoginCode",
  "refRememberMe",
];

const normalizePackage = (pkg = {}) => {
  const title = String(pkg?.title || pkg?.packageTitle || "").trim();
  if (!title) return null;
  return {
    title,
    price: String(pkg?.price || pkg?.packagePrice || "").trim(),
    tag: String(pkg?.tag || pkg?.packageTag || "").trim(),
  };
};

export const persistBookingPackageSelection = (pkg) => {
  if (typeof window === "undefined") return null;
  const selectedPackage = normalizePackage(pkg);
  if (!selectedPackage) return null;
  try {
    const raw = window.sessionStorage.getItem(BOOKING_DRAFT_STORAGE_KEY);
    const parsed = raw
      ? { lastTitle: null, packages: {}, ...JSON.parse(raw) }
      : { lastTitle: null, packages: {} };
    const current = parsed.packages?.[selectedPackage.title] || {};
    parsed.packages = {
      ...(parsed.packages || {}),
      [selectedPackage.title]: {
        ...current,
        selectedPackage,
      },
    };
    parsed.lastTitle = selectedPackage.title;
    window.sessionStorage.setItem(
      BOOKING_DRAFT_STORAGE_KEY,
      JSON.stringify(parsed)
    );
  } catch {}
  return selectedPackage;
};

export const readBookingPackageSelection = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(BOOKING_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const selected = parsed?.packages?.[parsed?.lastTitle]?.selectedPackage;
    return normalizePackage(selected);
  } catch {
    return null;
  }
};

export const readStoredCheckoutBooking = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CHECKOUT_BOOKING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
};

export const readCheckoutDraftRevision = (bookingData) => {
  try {
    const parsed = JSON.parse(readBrowserStorage("sessionStorage", BOOKING_DRAFT_STORAGE_KEY) || "null");
    const draft = parsed?.packages?.[bookingData?.packageTitle];
    if (!draft?.form) return null;
    const matches = ["discord", "email", "specs", "mainGame", "notes"].every(key =>
      String(draft.form[key] || "").trim() === String(bookingData[key === "notes" ? "message" : key] || "").trim()
    );
    const revision = Number(draft.formRevision || 0);
    return matches && Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  } catch {
    return null;
  }
};

export const clearCompletedCheckoutDraft = (bookingData, expectedRevision) => {
  if (expectedRevision === null || readCheckoutDraftRevision(bookingData) !== expectedRevision) return null;
  try {
    const parsed = JSON.parse(readBrowserStorage("sessionStorage", BOOKING_DRAFT_STORAGE_KEY));
    const title = bookingData.packageTitle;
    const current = parsed.packages[title];
    const formRevision = Math.max(Date.now(), expectedRevision + 1);
    parsed.packages[title] = { selectedPackage: current.selectedPackage, formRevision };
    if (!writeBrowserStorage("sessionStorage", BOOKING_DRAFT_STORAGE_KEY, JSON.stringify(parsed))) return null;
    clearBookingHoldExpired();
    return formRevision;
  } catch {
    return null;
  }
};

export const writeStoredCheckoutBooking = (bookingData) => {
  if (typeof window === "undefined") return null;
  if (!bookingData || typeof bookingData !== "object" || Array.isArray(bookingData)) {
    return null;
  }
  try {
    window.sessionStorage.setItem(
      CHECKOUT_BOOKING_STORAGE_KEY,
      JSON.stringify(bookingData)
    );
    return bookingData;
  } catch {
    return null;
  }
};

export const updateStoredCheckoutHold = (hold = {}) => {
  const current = readStoredCheckoutBooking();
  const slotHoldId = String(hold.slotHoldId || "").trim();
  const slotHoldToken = String(hold.slotHoldToken || "").trim();
  const slotHoldExpiresAt = String(hold.slotHoldExpiresAt || "").trim();
  if (!current || !slotHoldId || !slotHoldToken || !slotHoldExpiresAt) {
    return null;
  }

  return writeStoredCheckoutBooking({
    ...current,
    slotHoldId,
    slotHoldToken,
    slotHoldExpiresAt,
  });
};

export const migrateCheckoutStorageToSession = () => {
  if (typeof window === "undefined") return;
  LEGACY_CHECKOUT_KEYS.forEach((key) => {
    try {
      const legacyValue = window.localStorage.getItem(key);
      if (legacyValue !== null && window.sessionStorage.getItem(key) === null) {
        window.sessionStorage.setItem(key, legacyValue);
      }
      window.localStorage.removeItem(key);
    } catch {}
  });
};

const REFERRAL_SESSION_STORAGE_KEY = "referral_session";

export const rememberReferralFromSearch = (search) => {
  if (typeof window === "undefined") return;
  const code = String(new URLSearchParams(search || "").get("ref") || "").trim();
  if (!code) return;
  try {
    window.sessionStorage.setItem(REFERRAL_SESSION_STORAGE_KEY, code);
  } catch {}
};
