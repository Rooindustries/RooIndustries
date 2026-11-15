import { reportRequestError } from "./clientRequest";
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

const completedBooking = (receipt) => [
  receipt.paymentType === "paid" ? "booking_completed" : "free_booking_completed",
  {
    event_id: receipt.eventId,
    package: receipt.packageTitle,
    payment_type: receipt.paymentType,
    payment_provider: receipt.provider,
    amount: receipt.amount,
    currency: receipt.currency,
    referral_code: receipt.referralCode || "",
  },
];

const validReceipt = (receipt) => Boolean(receipt) && /^[a-f0-9]{40}$/.test(receipt.eventId || "") &&
  ["paid", "free"].includes(receipt.paymentType) && Number.isFinite(receipt.amount) && receipt.amount >= 0;

export const trackConfirmedPurchase = (receipt) => {
  if (!validReceipt(receipt)) return;
  const booking = completedBooking(receipt);
  keepPostHogEvent(...booking, { mark: `booking:${receipt.eventId}` });
  import("./bookingAnalytics")
    .then(({ trackBookingOnce }) => trackBookingOnce(receipt, booking))
    .catch(reportRequestError);
};
