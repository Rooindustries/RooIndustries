const {
  getPaymentPackageTitleAliases,
  resolvePaymentQuote,
} = require("../ref/pricing.js");
const { resolvePaymentProviders } = require("./providerConfig.js");
const { resolveQuoteRequestCurrency, validateUpgradeQuoteProvider } = require("./quoteCompatibility.js");
const { assertRazorpayAmountIncrement } = require("./providerClients.js");
const { buildQuoteFingerprint } = require("./paymentRecord.js");
const { verifyUpgradeIntentToken } = require("../ref/upgradeIntentToken.js");
const {
  consumeQuoteRateLimitWithPricing,
  getClientAddress,
  requireRateLimit,
} = require("../ref/rateLimit.js");
const { isKnownAdRefTag } = require("../../../lib/refShape.js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const requestBody = req.body || {};
    const bookingPayload =
      requestBody.bookingPayload && typeof requestBody.bookingPayload === "object"
        ? requestBody.bookingPayload
        : requestBody;
    const {
      packageTitle = "",
      originalOrderId = "",
      referralId = "",
      referralCode = "",
      couponCode = "",
      email = "",
      upgradeIntentToken = "",
    } = bookingPayload;

    const limitOptions = {
      key: `payment-quote:${getClientAddress(req)}`,
      max: 30,
      windowMs: 15 * 60 * 1000,
      message: "Too many payment quote requests. Please try again later.",
    };
    if (!String(packageTitle || "").trim()) {
      const allowed = await requireRateLimit(res, limitOptions);
      if (!allowed) return;
      return res.status(400).json({
        ok: false,
        error: "Package details are required to quote payment.",
      });
    }

    const safeReferralCode = isKnownAdRefTag(referralCode) ? "" : referralCode;
    const combined =
      !originalOrderId &&
      typeof consumeQuoteRateLimitWithPricing === "function"
        ? await consumeQuoteRateLimitWithPricing(res, {
            ...limitOptions,
            packageTitles:
              typeof getPaymentPackageTitleAliases === "function"
                ? getPaymentPackageTitleAliases(packageTitle)
                : [packageTitle],
            referralId,
            referralCode: safeReferralCode,
            couponCode,
          })
        : { handled: false };
    if (combined.handled && !combined.allowed) return;
    if (!combined.handled) {
      const allowed = await requireRateLimit(res, limitOptions);
      if (!allowed) return;
    }

    if (originalOrderId && !String(email || "").trim()) {
      return res.status(400).json({
        ok: false,
        code: "upgrade_email_required",
        error: "The original booking email is required to quote an upgrade.",
      });
    }

    if (
      originalOrderId &&
      !verifyUpgradeIntentToken({
        token: upgradeIntentToken,
        bookingId: originalOrderId,
        email,
        targetPackageTitle: packageTitle,
      })
    ) {
      return res.status(403).json({
        ok: false,
        code: "upgrade_intent_invalid",
        error: "Upgrade authorization expired or no longer matches.",
      });
    }

    const providers = resolvePaymentProviders();
    const requestedProvider = String(requestBody.provider || bookingPayload.paymentProvider || "").trim().toLowerCase();
    const reqCur = resolveQuoteRequestCurrency({ providers, requestedProvider, originalOrderId, requireEnabled: true });
    if (reqCur.error) return res.status(reqCur.error.status).json({ ok: false, code: reqCur.error.code, error: reqCur.error.error });

    const resolvedQuote = await resolvePaymentQuote({
      packageTitle,
      originalOrderId,
      referralId,
      referralCode: safeReferralCode,
      couponCode,
      currency: reqCur.currency,
      pricingInputs: combined.pricingInputs,
    });
    const isFree = resolvedQuote.paymentProvider === "free";
    const quoteCurrency = originalOrderId
      ? String(resolvedQuote.currency || "USD").trim().toUpperCase() || "USD"
      : String(resolvedQuote.currency || reqCur.currency || "USD").trim().toUpperCase() || "USD";
    const upgradeErr = originalOrderId && !isFree
      ? validateUpgradeQuoteProvider({ providers, requestedProvider, quoteCurrency, requireAnyEnabled: true }) : null;
    if (upgradeErr) return res.status(upgradeErr.status).json({ ok: false, code: upgradeErr.code, error: upgradeErr.error });
    if (requestedProvider === "razorpay" && !isFree) assertRazorpayAmountIncrement(resolvedQuote.effectiveNetAmount, quoteCurrency);

    const quoteFingerprint = buildQuoteFingerprint({
      bookingPayload,
      quote: { ...resolvedQuote, currency: quoteCurrency },
      currency: quoteCurrency,
    });

    return res.status(200).json({
      ok: true,
      currency: quoteCurrency,
      quoteFingerprint,
      quote: {
        currency: quoteCurrency,
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
        couponDiscountType: resolvedQuote.couponDiscountType,
        couponDiscountValue: resolvedQuote.couponDiscountValue,
        canCombineWithReferral: resolvedQuote.canCombineWithReferral === true,
      },
      providers: isFree
        ? {
            dodo: { enabled: false, mode: providers.dodo.mode, currency: providers.dodo.currency },
            razorpay: {
              enabled: false,
              mode: providers.razorpay.mode,
              currency: providers.razorpay.currency,
            },
            paypal: {
              enabled: false,
              mode: providers.paypal.mode,
              currency: providers.paypal.currency,
              clientId: "",
            },
          }
        : providers,
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const clientError = status >= 400 && status < 500;
    return res.status(status).json({
      ok: false,
      error:
        clientError && String(error?.message || "").trim()
          ? error.message
          : "Failed to quote payment.",
      ...(clientError && String(error?.code || "").trim()
        ? { code: error.code }
        : {}),
      ...(clientError && error?.completedUpgrade
        ? { completedUpgrade: error.completedUpgrade }
        : {}),
    });
  }
};
