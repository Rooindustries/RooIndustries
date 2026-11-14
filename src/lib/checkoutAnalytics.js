import { loadSalesAttribution, withMetaPixel } from "./analyticsModules";
import { DEFAULT_CURRENCY, metaTrack, packageFields, trackEvent } from "./analytics";
import { keepPostHogEvent } from "./loadPostHog";

export const trackCheckoutSessionStarted = ({ packageTitle, price, provider, moment } = {}) => {
  try {
    const pkg = packageFields(packageTitle, price);
    if (!pkg) return false;
    trackEvent("checkout_started", {
      package: pkg.name,
      package_slug: pkg.slug,
      provider: String(provider || ""),
      value: pkg.value,
      currency: DEFAULT_CURRENCY,
    }, { moment });
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

const completedBooking = (receipt) => [
  receipt.paymentType === "paid" ? "booking_completed" : "free_booking_completed",
  {
    event_id: receipt.eventId,
    package: receipt.packageTitle,
    payment_type: receipt.paymentType,
    payment_provider: receipt.provider,
    amount: receipt.amount,
    currency: receipt.currency,
  },
];

const keepCompletedBooking = (receipt) => {
  const key = `posthog_booking_tracked:${receipt.eventId}`;
  if (!counted(key) && keepPostHogEvent(...completedBooking(receipt))) remember(key);
};

const trackCompletedBooking = async (receipt) => {
  const [event, fields] = completedBooking(receipt);
  const data = { ...fields, referral_code: receipt.referralCode || "" };
  return Boolean(await loadSalesAttribution()) &&
    trackEvent(event, data, { attribution: receipt.attribution ?? null, postHog: false });
};

const validReceipt = (receipt) => Boolean(receipt) && /^[a-f0-9]{40}$/.test(receipt.eventId || "") &&
  ["paid", "free"].includes(receipt.paymentType) && Number.isFinite(receipt.amount) && receipt.amount >= 0;

export const trackConfirmedPurchase = (receipt) => {
  if (!validReceipt(receipt)) return;
  keepCompletedBooking(receipt);
  sendOnce(`booking_completion_tracked:${receipt.eventId}`, () => trackCompletedBooking(receipt));
  if (receipt.paymentType === "paid") {
    sendOnce(`meta_purchase_tracked:${receipt.eventId}`, () => trackPaidPurchaseOnMeta(receipt));
  }
};
