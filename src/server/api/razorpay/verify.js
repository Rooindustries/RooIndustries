const crypto = require("crypto");
const { resolvePaymentProviders } = require("../payment/providerConfig.js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const providers = resolvePaymentProviders();
    if (!providers?.razorpay?.enabled) {
      const previewMessage =
        providers?.runtime === "preview" && !providers?.previewPaymentsEnabled
          ? "Razorpay verification is disabled on preview deployments."
          : "Razorpay is not available in this environment.";
      return res.status(403).json({ ok: false, message: previewMessage });
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

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    const isAuthentic = expectedSignature === razorpay_signature;

    if (!isAuthentic) {
      return res.status(400).json({ ok: false, message: "Invalid signature" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Razorpay verify error:", err);
    return res.status(500).json({
      ok: false,
      message: "Server error verifying payment",
    });
  }
};
