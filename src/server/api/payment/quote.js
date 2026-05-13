const { resolvePaymentQuote } = require("../ref/pricing.js");
const { resolvePaymentProviders } = require("./providerConfig.js");
const { resolveMarket } = require("../../../lib/market.js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const {
      packageTitle = "",
      originalOrderId = "",
      referralId = "",
      referralCode = "",
      couponCode = "",
    } = req.body || {};
    const market = resolveMarket({
      hostname: req.headers?.host || req.headers?.["x-forwarded-host"] || "",
    });

    if (!String(packageTitle || "").trim()) {
      return res.status(400).json({
        ok: false,
        error: "Package details are required to quote payment.",
      });
    }

    const resolvedQuote = await resolvePaymentQuote({
      packageTitle,
      originalOrderId,
      referralId,
      referralCode,
      couponCode,
      currency: market.currency,
    });
    const providers = resolvePaymentProviders({
      hostname: req.headers?.host || req.headers?.["x-forwarded-host"] || "",
    });
    const isFree = resolvedQuote.paymentProvider === "free";

    return res.status(200).json({
      ok: true,
      quote: {
        grossAmount: resolvedQuote.effectiveGrossAmount,
        discountAmount: resolvedQuote.effectiveDiscountAmount,
        discountPercent: resolvedQuote.effectiveDiscountPercent,
        netAmount: isFree ? 0 : resolvedQuote.effectiveNetAmount,
        isFree,
        referralDiscountPercent: resolvedQuote.referralDiscountPercent,
        referralDiscountAmount: resolvedQuote.referralDiscountAmount,
        commissionPercent: resolvedQuote.effectiveCommissionPercent,
        couponDiscountPercent: resolvedQuote.couponDiscountPercent,
        couponDiscountAmount: resolvedQuote.couponDiscountAmount,
        canCombineWithReferral: resolvedQuote.canCombineWithReferral === true,
        currency: resolvedQuote.currency || market.currency,
      },
      providers: isFree
        ? {
            razorpay: {
              enabled: false,
              mode: providers.razorpay.mode,
            },
            paypal: {
              enabled: false,
              mode: providers.paypal.mode,
              clientId: "",
            },
            payu: {
              enabled: false,
              mode: providers.payu.mode,
            },
          }
        : providers,
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return res.status(status).json({
      ok: false,
      error: error?.message || "Failed to quote payment.",
      code: error?.code || "",
    });
  }
};
