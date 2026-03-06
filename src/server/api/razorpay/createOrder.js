function getCredentials() {
  const keyId = process.env.RAZORPAY_KEY_ID || "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
  if (!keyId || !keySecret) {
    return null;
  }
  return { keyId, keySecret };
}

function toSubunits(amount, currency = "USD") {
  const factors = { USD: 100, INR: 100, JPY: 1 };
  const factor = factors[currency] ?? 100;
  return Math.round(amount * factor);
}

function resolveServerCurrency() {
  return String(process.env.RAZORPAY_CURRENCY || "USD")
    .trim()
    .toUpperCase() || "USD";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const credentials = getCredentials();

  if (!credentials) {
    return res.status(500).json({
      ok: false,
      message: "Razorpay keys are missing on the server",
    });
  }

  try {
    const { notes = {} } = req.body || {};
    const currency = resolveServerCurrency();

    if (!notes?.packageTitle) {
      return res.status(400).json({
        ok: false,
        message: "Missing package details required to create the order",
      });
    }

    const pricingModule = await import("./../ref/pricing.js");
    const pricing = await pricingModule.resolveBookingPricing({
      packageTitle: notes.packageTitle,
      originalOrderId: notes.originalOrderId || "",
      referralCode: notes.referralCode || "",
      couponCode: notes.couponCode || "",
      paymentProvider: "razorpay",
    });

    const options = {
      amount: toSubunits(pricing.effectiveNetAmount, currency),
      currency,
      receipt: `booking_${Date.now()}`,
      notes: {
        packageTitle: notes.packageTitle || "",
        originalOrderId: notes.originalOrderId || "",
        referralCode: notes.referralCode || "",
        couponCode: notes.couponCode || "",
        expectedAmount: String(pricing.effectiveNetAmount),
      },
    };

    const basic = Buffer.from(
      `${credentials.keyId}:${credentials.keySecret}`
    ).toString("base64");

    const upstream = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(options),
    });

    const order = await upstream.json();

    if (!upstream.ok || !order?.id) {
      const details = order?.error?.description || order?.error?.reason || order?.error?.code;
      throw new Error(details || `Razorpay order create failed (${upstream.status})`);
    }

    return res.status(200).json({
      ok: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: credentials.keyId,
    });
  } catch (err) {
    console.error("Razorpay createOrder error:", err);
    return res.status(500).json({
      ok: false,
      message:
        err?.message || "Failed to create Razorpay order",
    });
  }
};
