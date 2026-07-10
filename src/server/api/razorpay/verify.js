const crypto = require("crypto");
const { resolvePaymentProviders } = require("../payment/providerConfig.js");
const { logSafeError } = require("../../safeErrorLog.js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const compatibilityDeadline = new Date(
    String(process.env.PAYMENT_LEGACY_COMPLETION_UNTIL || "")
  ).getTime();
  if (
    !Number.isFinite(compatibilityDeadline) ||
    compatibilityDeadline <= Date.now()
  ) {
    return res.status(410).json({
      ok: false,
      message: "This checkout session expired. Please restart checkout.",
    });
  }

  try {
    const providers = resolvePaymentProviders();
    if (!providers?.razorpay?.enabled) {
      return res.status(400).json({
        ok: false,
        message: "Razorpay is not available in this environment.",
      });
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        ok: false,
        message: "Missing payment verification details",
      });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const keySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(body.toString())
      .digest("hex");
    const suppliedSignature = String(razorpay_signature || "").trim();
    const expectedBuffer = Buffer.from(expectedSignature);
    const suppliedBuffer = Buffer.from(suppliedSignature);
    const isAuthentic =
      expectedBuffer.length === suppliedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);

    if (!isAuthentic) {
      return res.status(400).json({ ok: false, message: "Invalid signature" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    logSafeError("Razorpay verification failed", err);
    return res.status(500).json({
      ok: false,
      message: "Server error verifying payment",
    });
  }
};
