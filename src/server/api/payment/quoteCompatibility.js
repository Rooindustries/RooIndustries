import { resolvePaymentCurrency } from "../ref/bookingRefunds.js";
import { buildQuoteFingerprint } from "./paymentRecord.js";
import { getPayPalCurrency, getRazorpayCurrency } from "./providerClients.js";

const PAID_PROVIDER_ORDER = ["dodo", "razorpay", "paypal"];
const resolveProviderCurrency = (provider, providers = {}) => {
  const p = String(provider || "").trim().toLowerCase();
  return p === "dodo" ? "USD" : p === "razorpay" ? String(providers?.razorpay?.currency || getRazorpayCurrency()).trim().toUpperCase() || "USD"
    : p === "paypal" ? String(providers?.paypal?.currency || getPayPalCurrency()).trim().toUpperCase() || "USD" : "";
};
export const resolveQuoteRequestCurrency = ({ providers, requestedProvider = "", originalOrderId = "", requireEnabled = false }) => {
  if (originalOrderId) return { currency: "USD" };
  if (requestedProvider && PAID_PROVIDER_ORDER.includes(requestedProvider)) {
    if (requireEnabled && !providers[requestedProvider]?.enabled) {
      return { error: { status: 400, code: "provider_unavailable", error: "Selected payment provider is not available in this environment." } };
    }
    return { currency: resolveProviderCurrency(requestedProvider, providers) || "USD" };
  }
  const first = PAID_PROVIDER_ORDER.find((p) => providers[p]?.enabled) || "";
  return { currency: (first && resolveProviderCurrency(first, providers)) || "USD" };
};
export const validateUpgradeQuoteProvider = ({ providers, requestedProvider = "", quoteCurrency = "USD", requireAnyEnabled = false }) => {
  if (requestedProvider && PAID_PROVIDER_ORDER.includes(requestedProvider)) {
    const provCur = resolveProviderCurrency(requestedProvider, providers);
    if ((requireAnyEnabled && !providers[requestedProvider]?.enabled) || provCur !== quoteCurrency) {
      return { status: 409, code: "provider_currency_mismatch", error: `Selected provider does not support upgrade currency ${quoteCurrency}.` };
    }
  } else if (requireAnyEnabled && !PAID_PROVIDER_ORDER.some((p) => providers[p]?.enabled && resolveProviderCurrency(p, providers) === quoteCurrency)) {
    return { status: 409, code: "upgrade_currency_provider_unavailable", error: `No enabled payment provider supports upgrade currency ${quoteCurrency}.` };
  }
  return null;
};

const snapshotQuote = (r = {}) => {
  const s = r?.pricingSnapshot && typeof r.pricingSnapshot === "object" ? r.pricingSnapshot : {}, isFree = String(r?.provider || "").trim().toLowerCase() === "free";
  return {
    paymentProvider: isFree ? "free" : "paid", effectiveGrossAmount: Number(s.grossAmount || 0), effectiveNetAmount: isFree ? 0 : Number(s.netAmount || 0),
    effectiveDiscountAmount: Number(s.discountAmount || 0), effectiveReferralId: String(s.effectiveReferralId || s.referralId || "").trim(),
    effectiveReferralCode: String(s.effectiveReferralCode || s.referralCode || "").trim(), currency: String(s.currency || "").trim().toUpperCase(),
  };
};

export const resolveCompatibleQuoteFingerprint = ({ record = {}, claim = null } = {}) => {
  const invalid = (currency = "") => ({ quoteFingerprint: "", quoteFingerprintValid: false, currency, migratedFromLegacy: false });
  let currency = "";
  try { currency = resolvePaymentCurrency(record, { fallback: "" }); } catch { return invalid(""); }
  const storedFp = String(record?.quoteFingerprint || "").trim(), claimFp = String(claim?.quoteFingerprint || "").trim();
  if (!currency || !storedFp || (claimFp && claimFp !== storedFp)) return invalid(currency);
  const quote = snapshotQuote(record), bookingPayload = record?.bookingPayload || {}, expectedV2 = buildQuoteFingerprint({ bookingPayload, quote, currency });
  if (storedFp === expectedV2) return { quoteFingerprint: expectedV2, quoteFingerprintValid: true, currency, migratedFromLegacy: false };
  if (record?.quoteFingerprintVersion == null) {
    const expectedLegacy = buildQuoteFingerprint({ bookingPayload, quote, legacy: true });
    if (storedFp === expectedLegacy && (!claimFp || claimFp === expectedLegacy)) return { quoteFingerprint: expectedV2, quoteFingerprintValid: true, currency, migratedFromLegacy: true };
  }
  return invalid(currency);
};
