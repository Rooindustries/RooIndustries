import { parseMoneySubunits } from "./providerClients.js";

export const ACTIVE_UPGRADE_LOCK_STATUSES = ["captured_client", "captured_webhook", "verified_server", "finalizing", "needs_recovery"];
const validCur = (v) => (/^[A-Z]{3}$/.test(String(v || "").trim().toUpperCase()) ? String(v).trim().toUpperCase() : "");

export const buildProviderPayloadForRecord = (record = {}, { forStatus = false } = {}) => {
  const provider = String(record.provider || "").trim().toLowerCase();
  if (provider === "dodo") {
    const payload = { ...record.providerPublicData, orderId: record.providerOrderId };
    if (forStatus && (record.providerPaymentId || record.providerPaymentState || record.dodoAttemptObserved === true)) delete payload.checkoutUrl;
    return payload;
  }
  const currency = validCur(record.providerPublicData?.currency) || validCur(record.pricingSnapshot?.currency);
  if (provider === "razorpay") return { orderId: String(record.providerOrderId || "").trim(), key: String(record.providerPublicData?.key || "").trim(), currency, amount: Number(record.providerPublicData?.amount || 0) };
  if (provider === "paypal") {
    const stored = Number(record.providerPublicData?.amount || 0);
    const amount = Number.isSafeInteger(stored) && stored > 0 ? stored : currency && record.pricingSnapshot?.netAmount != null ? parseMoneySubunits(record.pricingSnapshot.netAmount, currency) || 0 : 0;
    return { orderId: String(record.providerOrderId || "").trim(), currency, amount, clientId: String(record.providerPublicData?.clientId || "").trim() };
  }
  return {};
};
export const buildStatusLockExtension = (record = {}) => {
  const provider = String(record.provider || "").trim().toLowerCase(), ready = provider === "free" || Boolean(String(record.providerOrderId || "").trim());
  const started = String(record.status || "").trim().toLowerCase() === "started";
  return { providerOrderReady: ready, ...(started && ready && provider !== "free" ? { providerPayload: buildProviderPayloadForRecord(record, { forStatus: true }) } : {}) };
};
export const buildLockedSessionPayload = ({ record, issueToken, buildQuoteFromSnapshot, quoteCompatibility = null }) => {
  const provider = String(record?.provider || "").trim().toLowerCase(), fp = quoteCompatibility ? quoteCompatibility.quoteFingerprint : String(record?.quoteFingerprint || "").trim();
  return {
    provider, status: String(record?.status || "").trim().toLowerCase(), ...buildStatusLockExtension(record),
    paymentAccessToken: provider === "free" ? "" : issueToken(record), sessionExpiresAt: String(record?.sessionExpiresAt || "").trim(),
    originalOrderId: String(record?.bookingPayload?.originalOrderId || "").trim(), upgradeIntentId: String(record?.upgradeIntentSnapshot?.intentId || "").trim(),
    packageTitle: String(record?.bookingPayload?.packageTitle || "").trim(), email: String(record?.bookingPayload?.email || "").trim(),
    quote: buildQuoteFromSnapshot(record), quoteFingerprint: fp, quoteFingerprintValid: quoteCompatibility ? quoteCompatibility.quoteFingerprintValid : Boolean(fp),
    couponCode: String(record?.bookingPayload?.couponCode || "").trim(),
    referralCode: String(record?.pricingSnapshot?.effectiveReferralCode || record?.bookingPayload?.referralCode || "").trim(),
  };
};
export const buildUpgradeLockConflictError = ({ record, bookingPayload, sessionScope, buildLockedSession, allowedReuseStatuses }) => {
  const match = record.bookingPayload?.originalOrderId === bookingPayload.originalOrderId && record.bookingPayload?.email === bookingPayload.email && record.bookingPayload?.packageTitle === bookingPayload.packageTitle;
  if (!allowedReuseStatuses.includes(record.status)) {
    const active = ACTIVE_UPGRADE_LOCK_STATUSES.includes(record.status) && match;
    return Object.assign(new Error(active ? "Another upgrade is already using this booking's credit." : "The previous upgrade checkout is closed. Please start a new upgrade."), { status: 409, code: active ? "upgrade_already_in_progress" : "upgrade_checkout_closed", ...(active ? { lockedSession: buildLockedSession(record) } : {}) });
  }
  if (!match || (record.status === "started" && String(record.sessionScope || "") !== String(sessionScope || ""))) {
    return Object.assign(new Error("Another upgrade is already using this booking's credit."), { status: 409, code: "upgrade_already_in_progress", ...(match ? { lockedSession: buildLockedSession(record) } : {}) });
  }
  return null;
};
