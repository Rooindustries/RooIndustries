export const installCheckoutProbe = (context, checkout) => context.addInitScript(booking => {
  sessionStorage.setItem("checkout_booking_state", JSON.stringify(booking));
  const send = window.fetch.bind(window);
  window.fetch = (input, options = {}) => {
    if (typeof input !== "string") return send(input, options);
    const url = new URL(input, location.href);
    const provider = /(?:^|\.)(?:paypal|razorpay|dodopayments)\.com$/.test(url.hostname);
    if (provider && /\/(?:orders?|payments?|checkouts?|subscriptions?)(?:\/|$)/i.test(
      decodeURIComponent(url.pathname)
    )) return Promise.reject(new Error("Production smoke cannot request provider order or payment APIs."));
    if (options.method !== "POST") return send(input, options);
    if (url.origin !== location.origin || url.pathname !== "/api/payment/quote" || url.search) {
      return send(input, options);
    }
    let body;
    try { body = JSON.parse(options.body); } catch { return send(input, options); }
    const fields = [
      "packageTitle", "originalOrderId", "startTimeUTC", "email", "referralCode", "couponCode",
      "upgradeIntentToken",
    ];
    if (body?.packageTitle !== booking.packageTitle || !Object.entries(body).every(([key, value]) =>
      fields.includes(key) && (key === "packageTitle" || value === ""))) return send(input, options);
    url.searchParams.set("packageTitle", booking.packageTitle);
    const { method, headers, body: unused, ...readOptions } = options;
    return send(url.href, readOptions);
  };
}, checkout);
