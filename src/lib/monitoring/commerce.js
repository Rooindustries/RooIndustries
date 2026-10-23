const routes = new Map([
  ...["cancel", "finalize", "providers", "quote", "reconcile", "report", "start", "status"].map(
    (action) => [`/api/payment/${action}`, "checkout"]
  ),
  ...["dodo", "paypal", "razorpay"].map(
    (provider) => [`/api/payment/webhook/${provider}`, "webhook"]
  ),
  ...["/api/razorpay/createOrder", "/api/razorpay/verify", "/api/ref/getUpgradeInfo",
    "/api/ref/validateCoupon", "/api/ref/validateReferral"].map(
    (route) => [route, "checkout"]
  ),
  ...["/api/ref/createBooking", "/api/ref/sendBookingEmails", "/api/ref/updateBookingStatus",
    "/api/holdSlot", "/api/releaseHold", "/api/bookingAvailability"].map(
    (route) => [route, "booking"]
  ),
]);

export async function reportCommerceFailure(url, status) {
  try {
    const route = new URL(url).pathname;
    const surface = routes.get(route);
    if (!surface || status < 500 || status > 599) return;
    await globalThis[Symbol.for("roo.reportCommerceAlert")]?.({
      kind: "route",
      route,
      surface,
      status,
    });
  } catch {}
}

export async function reportPaymentMismatches(report) {
  try {
    const items = report.items.map(({ key, reason }) => ({ key, reason }));
    if (items.length) {
      await globalThis[Symbol.for("roo.reportCommerceAlert")]?.({ kind: "reconciliation", items });
    }
  } catch {}
}
