import { normalizeCurrencyCode, toMoney } from "./checkoutMoney";

const parseMoney = (v) => {
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const explicitCur = (v) => {
  const c = String(v || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? normalizeCurrencyCode(c) : "";
};

export const resolveInitialConsentBaseline = (b = {}) => {
  const rawExp = parseMoney(b?.expectedClientTotal), rawAcc = parseMoney(b?.acceptedQuoteTotal);
  const expCur = explicitCur(b?.expectedClientCurrency), accCur = explicitCur(b?.acceptedQuoteCurrency);
  if (b?.originalOrderId && rawAcc === null && rawExp === null && b?.packagePrice) {
    const c = accCur || expCur || "USD", a = Math.max(0, toMoney(b.packagePrice, c));
    return { expectedClientTotal: a, expectedClientCurrency: c, acceptedQuoteTotal: a, acceptedQuoteCurrency: c, acceptedServerQuoteBreakdown: null };
  }
  const eCur = expCur || accCur || (rawExp !== null ? "USD" : ""), aCur = accCur || expCur || (rawAcc !== null || rawExp !== null ? "USD" : "");
  const eTot = rawExp !== null ? toMoney(rawExp, eCur || "USD") : null;
  const aTot = rawAcc !== null ? toMoney(rawAcc, aCur || "USD") : (eTot !== null ? toMoney(eTot, aCur || "USD") : null);
  return {
    expectedClientTotal: eTot,
    expectedClientCurrency: eTot !== null ? eCur || "USD" : "",
    acceptedQuoteTotal: aTot,
    acceptedQuoteCurrency: aTot !== null ? aCur || "USD" : "",
    acceptedServerQuoteBreakdown: b?.acceptedServerQuoteBreakdown && typeof b.acceptedServerQuoteBreakdown === "object" ? b.acceptedServerQuoteBreakdown : null,
  };
};
