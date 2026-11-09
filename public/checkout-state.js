const unsaved = new Map();
const unsavedChoices = new Set();
let reportedDraft = null;

const hasMalformedDraft = () => {
  let value;
  try {
    value = window.sessionStorage.getItem("booking_draft");
  } catch {
    return false;
  }
  if (value === null) {
    reportedDraft = null;
    return false;
  }
  try {
    JSON.parse(value);
    reportedDraft = null;
    return false;
  } catch {
    if (reportedDraft !== value) {
      reportedDraft = value;
      window.dispatchEvent(new Event("checkout-draft-error"));
    }
    return true;
  }
};
const SAVE_STATE_EVENT = "checkout-save-state";
const announce = () => window.dispatchEvent(new Event(SAVE_STATE_EVENT));
const hasCodes = (value) => Boolean(
  value?.referralCode || value?.couponCode || value?.referral?.code ||
  value?.coupon?.code || value?.dismissedReferralCode
);

export const CHECKOUT_SAVE_NOTICE =
  "Your browser could not save your code choices. They still apply to this checkout, but reloading may lose them.";

export const hasCheckoutSaveFailure = () => unsavedChoices.size > 0;

export const subscribeCheckoutSaveFailure = (listener) => {
  window.addEventListener(SAVE_STATE_EVENT, listener);
  return () => window.removeEventListener(SAVE_STATE_EVENT, listener);
};

const createStore = (key, text, hasChoices) => {
  const read = () => {
    if (typeof window === "undefined") return null;
    if (key === "booking_draft" && !unsaved.has(key) && hasMalformedDraft()) return null;
    try {
      const value = unsaved.has(key) ? unsaved.get(key) : window.sessionStorage.getItem(key);
      return value === null || text ? value : JSON.parse(value);
    } catch {
      return null;
    }
  };
  const write = (value) => {
    if (typeof window === "undefined") return false;
    const serialized = value == null || (text && !value) ? null : text ? String(value) : JSON.stringify(value);
    const carriedChoices = hasChoices(value) || hasChoices(read()) || unsavedChoices.has(key);
    unsaved.set(key, serialized);
    if (key === "booking_draft" && hasMalformedDraft()) {
      if (carriedChoices) unsavedChoices.add(key);
      announce();
      return false;
    }
    let saved = false;
    try {
      const storage = window.sessionStorage;
      if (serialized === null) storage.removeItem(key);
      else storage.setItem(key, serialized);
      saved = storage.getItem(key) === serialized;
      if (saved) unsaved.delete(key);
    } catch {}
    if (!saved) {
      if (carriedChoices) unsavedChoices.add(key);
      console.error("Failed to save checkout choices");
    } else {
      unsavedChoices.delete(key);
    }
    announce();
    return saved;
  };
  const remove = (matches) => {
    if (typeof window !== "undefined" && key === "booking_draft" && hasMalformedDraft()) return false;
    if (matches && typeof window !== "undefined") {
      try {
        const stored = window.sessionStorage.getItem(key);
        if (stored !== null && !matches(text ? stored : JSON.parse(stored))) {
          if (matches(read())) {
            unsaved.delete(key);
            unsavedChoices.delete(key);
          }
          announce();
          return true;
        }
      } catch {}
    }
    return write(null);
  };
  return { read, write, remove };
};

export const bookingDraft = createStore("booking_draft", false, (draft) =>
  Object.values(draft?.packages || {}).some((pkg) => hasCodes(pkg?.checkoutCodes))
);
export const checkoutBooking = createStore("checkout_booking_state", false, (booking) =>
  hasCodes(booking) || hasCodes(booking?.checkoutCodes)
);
export const paymentSession = createStore("payment_session_state", false, (session) => {
  try {
    return hasCodes(JSON.parse(session?.fingerprint || "null"));
  } catch {
    return false;
  }
});
export const referralSession = createStore("referral_session", true, Boolean);

export const migrateBookingDraft = () => {
  if (typeof window === "undefined") return;
  try {
    const legacy = window.localStorage.getItem("booking_draft");
    if (legacy === null) return;
    if (bookingDraft.read() === null && !bookingDraft.write(JSON.parse(legacy))) return;
    window.localStorage.removeItem("booking_draft");
  } catch {}
};
