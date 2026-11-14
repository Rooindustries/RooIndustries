import { loadSalesAttribution, withMetaPixel } from "./analyticsModules";
import { DEFAULT_CURRENCY, metaTrack, packageFields, trackEvent } from "./analytics";

export const trackCheckoutSessionStarted = ({ packageTitle, price, provider } = {}) => {
  try {
    const pkg = packageFields(packageTitle, price);
    if (!pkg) return false;
    trackEvent("checkout_started", {
      package: pkg.name,
      package_slug: pkg.slug,
      provider: String(provider || ""),
      value: pkg.value,
      currency: DEFAULT_CURRENCY,
    });
    metaTrack("InitiateCheckout", {
      content_name: pkg.name,
      content_ids: pkg.slug ? [pkg.slug] : [],
      content_type: "product",
      num_items: 1,
      value: pkg.value,
      currency: DEFAULT_CURRENCY,
    });
    return true;
  } catch {
    return false;
  }
};

const receipts = new Set();

const sendOnce = (key, send) => {
  try {
    if (receipts.has(key) || sessionStorage.getItem(key)) return;
  } catch {}
  receipts.add(key);
  Promise.resolve().then(send).catch(() => false).then((sent) => {
    if (!sent) {
      receipts.delete(key);
      return;
    }
    try { sessionStorage.setItem(key, "1"); } catch {}
  });
};

const trackPaidPurchaseOnMeta = (receipt) => {
  const pkg = packageFields(receipt.packageTitle, receipt.amount);
  return Boolean(pkg) && withMetaPixel((pixel) => pixel.metaTrackWhenGranted("Purchase", {
    content_name: pkg.name,
    content_ids: pkg.slug ? [pkg.slug] : [],
    content_type: "product",
    value: receipt.amount,
    currency: receipt.currency,
  }, { eventId: receipt.eventId }));
};

const trackCompletedBooking = async (receipt) => Boolean(await loadSalesAttribution()) &&
  trackEvent(receipt.paymentType === "paid" ? "booking_completed" : "free_booking_completed", {
    event_id: receipt.eventId,
    package: receipt.packageTitle,
    payment_type: receipt.paymentType,
    payment_provider: receipt.provider,
    amount: receipt.amount,
    currency: receipt.currency,
    referral_code: receipt.referralCode || "",
  }, { attribution: receipt.attribution ?? null });

const validReceipt = (receipt) => Boolean(receipt) && /^[a-f0-9]{40}$/.test(receipt.eventId || "") &&
  ["paid", "free"].includes(receipt.paymentType) && Number.isFinite(receipt.amount) && receipt.amount >= 0;

export const trackConfirmedPurchase = (receipt) => {
  if (!validReceipt(receipt)) return;
  sendOnce(`booking_completion_tracked:${receipt.eventId}`, () => trackCompletedBooking(receipt));
  if (receipt.paymentType === "paid") {
    sendOnce(`meta_purchase_tracked:${receipt.eventId}`, () => trackPaidPurchaseOnMeta(receipt));
  }
};
