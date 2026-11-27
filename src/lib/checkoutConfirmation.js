import { extractTokenNonce } from "./checkoutStorage";
export { extractTokenNonce };
export const CHECKOUT_CONFIRMATION_EVENT = "checkout-confirmation";

const pending = new Map();
let nextId = 1;
const str = (v) => String(v || "").trim();
const holdKey = (h) => [str(h?.holdId || h?.slotHoldId), extractTokenNonce(h?.holdToken || h?.slotHoldToken)];
const sameNonce = (a, b) => !a || !b || a === b;
const rJson = (k) => { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch { return null; } };
const pJson = (v) => { try { return JSON.parse(v || "null"); } catch { return null; } };
export const announceCheckoutConfirmationChange = () => { if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHECKOUT_CONFIRMATION_EVENT)); };

export const beginCheckoutConfirmation = (hold = null) => {
  const id = nextId++, [holdId, nonce] = holdKey(hold);
  pending.set(id, { holdId, nonce });
  announceCheckoutConfirmationChange();
  let ended = false;
  return () => { if (!ended) { ended = true; pending.delete(id); announceCheckoutConfirmationChange(); } };
};
export const isCheckoutConfirmationPending = (hold = null) => {
  if (!pending.size) return false;
  if (!hold) return true;
  const [id, n] = holdKey(hold);
  for (const e of pending.values()) if (!e.holdId || (id && e.holdId === id && sameNonce(n, e.nonce))) return true;
  return false;
};
export const hasMatchingLockedPaymentSessionForHold = (hold) => {
  if (!hold || typeof window === "undefined") return false;
  const s = rJson("payment_session_state"), [id, n] = holdKey(hold);
  if (!s?.paymentAccessToken || !s?.provider || !id) return false;
  const fp = pJson(s.fingerprint), sk = pJson(s.scopeKey);
  if (fp?.originalOrderId || sk?.k === "u") return false;
  const r = s.result?.refreshedHold || s.result?.hold;
  if (r?.slotHoldId) return str(r.slotHoldId) === id && sameNonce(n, extractTokenNonce(r.slotHoldToken));
  if (s.sessionHoldId) return str(s.sessionHoldId) === id && sameNonce(n, extractTokenNonce(s.sessionHoldNonce));
  if (sk?.k === "b" && sk.h) return str(sk.h) === id && sameNonce(n, extractTokenNonce(sk.n));
  const c = rJson("checkout_booking_state");
  return Boolean(str(c?.slotHoldId) === id && sameNonce(n, extractTokenNonce(c?.slotHoldToken)) && fp && (!hold.startTimeUTC || fp.startTimeUTC === hold.startTimeUTC) && (!hold.packageTitle || fp.packageTitle === hold.packageTitle));
};
export const hasPendingPaymentStartForHold = (hold) => {
  if (!hold || typeof window === "undefined") return false;
  const [id, n] = holdKey(hold), now = Date.now(), st = rJson("roo_pending_payment_starts");
  return Boolean(id) && [...Object.values(window.__rooPendingStarts || {}), ...(st ? Object.values(st) : [])].some((e) => e && e.until > now && e.holdId === id && sameNonce(n, e.nonce));
};
export const isHoldProtectedFromExpiry = (hold, { paymentInOtherTab = false } = {}) => {
  if (!hold) return false;
  if (isCheckoutConfirmationPending(hold) || hasMatchingLockedPaymentSessionForHold(hold) || hasPendingPaymentStartForHold(hold)) return true;
  if (str(hold.phase).toLowerCase() !== "payment_pending") return false;
  if (paymentInOtherTab === true || hold.paymentStartedElsewhere === true) return true;
  const [id, n] = holdKey(hold), c = id ? rJson("checkout_booking_state") : null;
  return Boolean(id) && !(c?.slotHoldId === id && sameNonce(n, extractTokenNonce(c?.slotHoldToken)));
};
