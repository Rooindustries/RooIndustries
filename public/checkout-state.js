const unsaved = new Map();
const SAVE_STATE_EVENT = "checkout-save-state";
let reported = false;
const announce = () => window.dispatchEvent(new Event(SAVE_STATE_EVENT));

export const CHECKOUT_SAVE_NOTICE =
  "Your browser could not save your code choices. They still apply to this checkout, but reloading may lose them.";

export const hasCheckoutSaveFailure = () => unsaved.size > 0;

export const subscribeCheckoutSaveFailure = (listener) => {
  window.addEventListener(SAVE_STATE_EVENT, listener);
  return () => window.removeEventListener(SAVE_STATE_EVENT, listener);
};

const createStore = (key, text = false) => {
  const read = () => {
    if (typeof window === "undefined") return null;
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
    unsaved.set(key, serialized);
    let saved = false;
    try {
      const storage = window.sessionStorage;
      if (serialized === null) storage.removeItem(key);
      else storage.setItem(key, serialized);
      saved = storage.getItem(key) === serialized;
      if (saved) unsaved.delete(key);
    } catch {}
    if (!saved && !reported) {
      reported = true;
      console.error("Failed to save checkout choices");
    }
    announce();
    return saved;
  };
  const remove = (matches) => {
    if (matches && typeof window !== "undefined") {
      try {
        const stored = window.sessionStorage.getItem(key);
        if (stored !== null && !matches(text ? stored : JSON.parse(stored))) {
          if (matches(read())) unsaved.delete(key);
          announce();
          return true;
        }
      } catch {}
    }
    return write(null);
  };
  return { read, write, remove };
};

export const bookingDraft = createStore("booking_draft");
export const checkoutBooking = createStore("checkout_booking_state");
export const paymentSession = createStore("payment_session_state");
export const referralSession = createStore("referral_session", true);

export const migrateBookingDraft = () => {
  if (typeof window === "undefined") return;
  try {
    const legacy = window.localStorage.getItem("booking_draft");
    if (legacy === null) return;
    if (bookingDraft.read() === null && !bookingDraft.write(JSON.parse(legacy))) return;
    window.localStorage.removeItem("booking_draft");
  } catch {}
};
