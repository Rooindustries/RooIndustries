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

const normalizeReferralCode = (code) => String(code || "").trim().toLowerCase();
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const referralScope = (packageTitle, originalOrderId = "") =>
  JSON.stringify([String(packageTitle || "").trim(), String(originalOrderId || "").trim()]);

const readReferralIntent = () => {
  const raw = window.sessionStorage.getItem(REFERRAL_DISMISSED_STORAGE_KEY);
  if (raw === null) {
    return {
      passiveCode: normalizeReferralCode(window.sessionStorage.getItem(REFERRAL_SESSION_STORAGE_KEY)),
      codes: {},
      choices: {},
    };
  }
  const intent = JSON.parse(raw);
  if (
    !isRecord(intent) ||
    Object.keys(intent).length !== 3 ||
    !Object.hasOwn(intent, "passiveCode") || typeof intent.passiveCode !== "string" ||
    intent.passiveCode !== normalizeReferralCode(intent.passiveCode) ||
    !Object.hasOwn(intent, "codes") || !isRecord(intent.codes) ||
    !Object.hasOwn(intent, "choices") || !isRecord(intent.choices) ||
    Object.entries(intent.codes).some(([code, status]) =>
      !code || code !== normalizeReferralCode(code) || !["available", "applied", "removed"].includes(status)
    ) ||
    Object.entries(intent.choices).some(([scope, code]) => {
      let parts;
      try { parts = JSON.parse(scope); } catch { return true; }
      return !Array.isArray(parts) || parts.length !== 2 ||
        parts.some(part => typeof part !== "string" || part !== part.trim()) ||
        scope !== referralScope(...parts) || typeof code !== "string" ||
        !code || code !== normalizeReferralCode(code);
    })
  ) {
    throw new Error("Invalid referral intent.");
  }
  return intent;
};

const writeReferralIntent = (intent) => {
  window.sessionStorage.setItem(REFERRAL_DISMISSED_STORAGE_KEY, JSON.stringify(intent));
  try {
    if (intent.passiveCode) window.sessionStorage.setItem(REFERRAL_SESSION_STORAGE_KEY, intent.passiveCode);
    else window.sessionStorage.removeItem(REFERRAL_SESSION_STORAGE_KEY);
  } catch {}
};

export const readStoredReferral = () => {
  if (typeof window === "undefined") return "";
  try { return readReferralIntent().passiveCode; } catch { return ""; }
};

export const isReferralDismissed = (code, legacyDismissedCode = "") => {
  if (typeof window === "undefined") return true;
  const normalized = normalizeReferralCode(code);
  if (!normalized) return false;
  try {
    const intent = readReferralIntent();
    const status = Object.hasOwn(intent.codes, normalized) ? intent.codes[normalized] : undefined;
    if (status === "removed") return true;
    if (status !== "applied" && normalized === normalizeReferralCode(legacyDismissedCode)) {
      writeReferralIntent({
        ...intent,
        passiveCode: intent.passiveCode === normalized ? "" : intent.passiveCode,
        codes: { ...intent.codes, [normalized]: "removed" },
      });
      return true;
    }
    if (!status) writeReferralIntent({ ...intent, codes: { ...intent.codes, [normalized]: "available" } });
    return false;
  } catch {
    return true;
  }
};

export const rememberReferralFromSearch = (search) => {
  if (typeof window === "undefined") return;
  const code = normalizeReferralCode(new URLSearchParams(search || "").get("ref"));
  if (!code) return;
  try {
    const intent = readReferralIntent();
    const status = Object.hasOwn(intent.codes, code) ? intent.codes[code] : undefined;
    if (status === "removed") return;
    writeReferralIntent({
      ...intent,
      passiveCode: code,
      codes: { ...intent.codes, [code]: status || "available" },
    });
  } catch {}
};

export const dismissReferralCode = (code) => {
  if (typeof window === "undefined") return false;
  const normalized = normalizeReferralCode(code);
  if (!normalized) return false;
  try {
    const intent = readReferralIntent();
    writeReferralIntent({
      ...intent,
      passiveCode: intent.passiveCode === normalized ? "" : intent.passiveCode,
      codes: { ...intent.codes, [normalized]: "removed" },
    });
    return true;
  } catch {
    return false;
  }
};

export const clearReferralDismissal = (code, scope) => {
  if (typeof window === "undefined") return false;
  const normalized = normalizeReferralCode(code);
  if (!normalized || !scope) return false;
  try {
    const intent = readReferralIntent();
    writeReferralIntent({
      ...intent,
      passiveCode: normalized,
      codes: { ...intent.codes, [normalized]: "applied" },
      choices: { ...intent.choices, [scope]: normalized },
    });
    return true;
  } catch (error) {
    return error?.name === "SecurityError";
  }
};

export const recordAutomaticReferral = (code, scope) => {
  if (typeof window === "undefined") return false;
  const normalized = normalizeReferralCode(code);
  if (!normalized || !scope) return false;
  try {
    const intent = readReferralIntent();
    const status = Object.hasOwn(intent.codes, normalized) ? intent.codes[normalized] : undefined;
    if (status === "removed") return false;
    writeReferralIntent({
      ...intent,
      passiveCode: intent.passiveCode || normalized,
      codes: { ...intent.codes, [normalized]: status || "available" },
      choices: { ...intent.choices, [scope]: normalized },
    });
    return true;
  } catch {
    return false;
  }
};

export const selectStoredReferral = (scope, candidates = [], legacyDismissedCode = "") => {
  if (typeof window === "undefined") return "";
  try {
    const intent = readReferralIntent();
    const allowed = code => code && !isReferralDismissed(code, legacyDismissedCode);
    if (Object.hasOwn(intent.choices, scope)) {
      const current = intent.choices[scope];
      if (allowed(current)) return current;
      return allowed(intent.passiveCode) ? intent.passiveCode : "";
    }
    return [...candidates, intent.passiveCode].map(normalizeReferralCode).find(allowed) || "";
  } catch {
    return "";
  }
};

export const clearStoredReferral = (expectedCode) => {
  if (typeof window === "undefined") return false;
  const normalized = normalizeReferralCode(expectedCode);
  if (!normalized) return false;
  try {
    const intent = readReferralIntent();
    if (intent.passiveCode !== normalized) return true;
    writeReferralIntent({ ...intent, passiveCode: "" });
    return true;
  } catch {
    return false;
  }
};

export const resetReferralChoice = (scope) => {
  if (typeof window === "undefined" || !scope) return false;
  try {
    const intent = readReferralIntent();
    if (!Object.hasOwn(intent.choices, scope)) return true;
    const choices = { ...intent.choices };
    delete choices[scope];
    writeReferralIntent({ ...intent, choices });
    return true;
  } catch {
    return false;
  }
};
