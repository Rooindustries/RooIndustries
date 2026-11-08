import { writeBrowserStorage } from "./browserStorage.js";

const activeStates = {
  started: "resumable",
  needs_recovery_with_order: "confirming",
  needs_recovery_without_order: "confirming",
  paid: "confirming",
  expired: "start_again",
  closed: "start_again",
};
const providers = {
  dodo: activeStates,
  paypal: activeStates,
  razorpay: activeStates,
  free: activeStates,
};
const recoveryTable = { booking: providers, upgrade: providers };

export const checkoutRecoveryDecision = ({ kind, provider, status, providerOrderId, providerPayload,
  sessionExpiresAt, settled = false, providerState = "unpaid", amountMatches = true, now = Date.now() }) => {
  const validPayload = provider === "free" || (provider === "dodo" ? Boolean(providerPayload?.checkoutUrl)
    : Boolean(providerPayload?.orderId) && (provider === "paypal" || (provider === "razorpay" &&
      Boolean(providerPayload.key && providerPayload.currency) &&
      Number.isSafeInteger(providerPayload.amount) && providerPayload.amount > 0)));
  const closed = ["abandoned", "failed", "refunded"].includes(status);
  const paid = settled || ["booked", "email_partial", "captured_client", "captured_webhook", "verified_server",
    "finalizing"].includes(status) || ["captured", "refunded", "pending"].includes(providerState);
  const expiry = Date.parse(sessionExpiresAt);
  const state = closed ? "closed" : paid ? "paid"
    : !Number.isFinite(expiry) || expiry <= now || !amountMatches ? "expired"
    : provider !== "free" && (!providerOrderId || !validPayload || providerState !== "unpaid")
      ? "needs_recovery_without_order"
      : status === "needs_recovery" ? "needs_recovery_with_order" : status;
  const checkoutState = recoveryTable[kind]?.[provider]?.[state] || "start_again";
  return { state, checkoutState, providerPayload: checkoutState === "resumable" ? providerPayload || {} : null };
};

export const normalizePaymentSession = session => {
  const localNow = Date.now();
  const receivedAt = Number.isFinite(session.receivedAt) ? session.receivedAt : localNow;
  const checkedAt = session.result?.checkoutRecovery?.checkedAt;
  const now = Number.isFinite(checkedAt) ? checkedAt + Math.max(0, localNow - receivedAt) : localNow;
  let booking;
  try { booking = JSON.parse(session.fingerprint); } catch {}
  const decision = checkoutRecoveryDecision({ kind: booking?.originalOrderId ? "upgrade" : "booking",
    providerOrderId: session.providerPayload?.orderId,
    providerState: session.result?.status === "started" ? "unpaid" : "unavailable",
    ...session.result?.checkoutRecovery,
    provider: session.provider, status: session.result?.status, sessionExpiresAt: session.sessionExpiresAt,
    providerPayload: session.providerPayload, now });
  return { ...session, receivedAt, providerPayload: decision.providerPayload,
    result: { ...session.result, checkoutState: decision.checkoutState, providerPayload: decision.providerPayload } };
};

const PAYMENT_SESSION_STORAGE_KEY = "payment_session_state";
const PENDING_START_STORAGE_KEY = "checkout_pending_start";

export const rememberCheckoutStart = identity =>
  writeBrowserStorage("sessionStorage", PENDING_START_STORAGE_KEY, identity);

export const checkoutStartNeedsRecovery = identity => {
  try { return sessionStorage.getItem(PENDING_START_STORAGE_KEY) === identity; } catch { return false; }
};

const readPaymentCache = () => {
  try { return JSON.parse(sessionStorage.getItem(PAYMENT_SESSION_STORAGE_KEY) || "null"); } catch { return null; }
};
export const readStoredPaymentAccessToken = () => String(readPaymentCache()?.paymentAccessToken || "").trim();

export const readStoredPaymentSession = () => {
  try {
    const parsed = readPaymentCache();
    if (parsed?.paymentAccessToken && parsed.provider && parsed.fingerprint && (parsed.providerPayload || parsed.result)) {
      const session = normalizePaymentSession(parsed);
      if (session.providerPayload !== parsed.providerPayload) writeStoredPaymentSession(session);
      return session;
    }
  } catch {}
  return null;
};

export const writeStoredPaymentSession = session => {
  if (!session?.paymentAccessToken || !session.provider || !session.fingerprint) return false;
  const normalized = normalizePaymentSession(session);
  return writeBrowserStorage("sessionStorage", PAYMENT_SESSION_STORAGE_KEY,
    JSON.stringify({ ...normalized, providerPayload: normalized.providerPayload || {} }));
};

export const clearStoredPaymentSession = () => {
  try { sessionStorage.removeItem(PAYMENT_SESSION_STORAGE_KEY); } catch {}
  try { sessionStorage.removeItem(PENDING_START_STORAGE_KEY); } catch {}
};
