export const BOOKING_DRAFT_STORAGE_KEY = "booking_draft";
export const CHECKOUT_BOOKING_STORAGE_KEY = "checkout_booking_state";

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
const REFERRAL_DISMISSED_STORAGE_KEY = "referral_dismissed";

export const REFERRAL_STORAGE_ERROR =
  "Couldn't save this code change. Please try again.";

const readReferralIntent = () => {
  const raw = window.sessionStorage.getItem(REFERRAL_DISMISSED_STORAGE_KEY);
  const intent = raw === null ? {} : JSON.parse(raw);
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    Object.values(intent).some(
      (status) => !["available", "applied", "removed"].includes(status)
    )
  ) {
    throw new Error("Invalid referral intent.");
  }
  return intent;
};

export const isReferralDismissed = (code, legacyDismissedCode = "") => {
  if (typeof window === "undefined") return false;
  const normalized = String(code || "").trim().toLowerCase();
  if (!normalized) return false;
  try {
    const intent = readReferralIntent();
    const status = Object.hasOwn(intent, normalized) ? intent[normalized] : undefined;
    if (status === "removed") return true;
    if (
      status !== "applied" &&
      normalized === String(legacyDismissedCode || "").trim().toLowerCase()
    ) {
      window.sessionStorage.setItem(
        REFERRAL_DISMISSED_STORAGE_KEY,
        JSON.stringify({ ...intent, [normalized]: "removed" })
      );
      return true;
    }
    if (!status) {
      window.sessionStorage.setItem(
        REFERRAL_DISMISSED_STORAGE_KEY,
        JSON.stringify({ ...intent, [normalized]: "available" })
      );
    }
    return false;
  } catch {
    return true;
  }
};

export const rememberReferralFromSearch = (search) => {
  if (typeof window === "undefined") return;
  const code = String(new URLSearchParams(search || "").get("ref") || "").trim();
  if (!code || isReferralDismissed(code)) return;
  try {
    window.sessionStorage.setItem(REFERRAL_SESSION_STORAGE_KEY, code);
  } catch {}
};

export const dismissReferralCode = (code) => {
  if (typeof window === "undefined") return false;
  const normalized = String(code || "").trim().toLowerCase();
  if (!normalized) return false;
  try {
    const intent = readReferralIntent();
    window.sessionStorage.setItem(
      REFERRAL_DISMISSED_STORAGE_KEY,
      JSON.stringify({ ...intent, [normalized]: "removed" })
    );
  } catch {
    return false;
  }
  try {
    if (String(window.sessionStorage.getItem(REFERRAL_SESSION_STORAGE_KEY) || "").trim().toLowerCase() === normalized) {
      window.sessionStorage.removeItem(REFERRAL_SESSION_STORAGE_KEY);
    }
  } catch {}
  return true;
};

export const clearReferralDismissal = (code) => {
  if (typeof window === "undefined") return false;
  const normalized = String(code || "").trim().toLowerCase();
  if (!normalized) return false;
  try {
    const intent = readReferralIntent();
    window.sessionStorage.setItem(
      REFERRAL_DISMISSED_STORAGE_KEY,
      JSON.stringify({ ...intent, [normalized]: "applied" })
    );
    return true;
  } catch (error) {
    return error?.name === "SecurityError";
  }
};
