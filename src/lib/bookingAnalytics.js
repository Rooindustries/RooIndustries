import { loadSalesAttribution, withMetaPixel } from "./analyticsModules";
import { packageFields, trackEvent } from "./analytics";

const receipts = new Set();

const counted = (key) => {
  try {
    if (receipts.has(key) || sessionStorage.getItem(key)) return true;
  } catch {}
  receipts.add(key);
  return false;
};

const remember = (key) => {
  try { sessionStorage.setItem(key, "1"); } catch {}
};

const sendOnce = (key, send) => {
  if (counted(key)) return;
  new Promise((resolve) => resolve(send())).catch(() => false).then((sent) => {
    if (sent) remember(key);
    else receipts.delete(key);
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

const trackCompletedBooking = async (receipt, booking) => Boolean(await loadSalesAttribution()) &&
  trackEvent(...booking, { attribution: receipt.attribution ?? null, postHog: false });

export const trackBookingOnce = (receipt, booking) => {
  sendOnce(`booking_completion_tracked:${receipt.eventId}`, () => trackCompletedBooking(receipt, booking));
  if (receipt.paymentType === "paid") {
    sendOnce(`meta_purchase_tracked:${receipt.eventId}`, () => trackPaidPurchaseOnMeta(receipt));
  }
};
