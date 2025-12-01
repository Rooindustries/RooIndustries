const dotenv = require("dotenv");
dotenv.config({ path: ".env.local" });

const Razorpay = require("razorpay");

function createClient() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  console.log("Razorpay keys present?", {
    keyId: !!keyId,
    keySecret: !!keySecret,
  });

  if (!keyId || !keySecret) {
    return null;
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
}

function toSubunits(amount, currency = "USD") {
  const factors = { USD: 100, INR: 100, JPY: 1 };
  const factor = factors[currency] ?? 100;
  return Math.round(amount * factor);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const razorpay = createClient();

  if (!razorpay) {
    return res.status(500).json({
      ok: false,
      message: "Razorpay keys are missing on the server",
    });
  }

  try {
    const { amount, currency = "USD", notes } = req.body || {};

    if (!amount || !currency) {
      return res
        .status(400)
        .json({ ok: false, message: "Missing amount or currency" });
    }

    const options = {
      amount: toSubunits(amount, currency),
      currency,
      receipt: `booking_${Date.now()}`,
      notes: notes || {},
      checkout_config_id: "config_Rm7exJgvjrWbQ8",
    };

    const order = await razorpay.orders.create(options);

    return res.status(200).json({
      ok: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("Razorpay createOrder error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to create Razorpay order",
    });
  }
};
