import { createClient } from "@sanity/client";
import crypto from "crypto";
import { verifyHoldToken } from "../../booking/holdToken.js";
import { resolveBookingPricing, resolveUpgradeContext } from "./pricing.js";
import {
  buildSlotBookingId,
  buildSlotHoldId,
} from "../../booking/slotIdentity.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import {
  buildDeferredEmailDispatch,
  getBookingForEmailDispatch,
  sendBookingEmailsForBooking,
} from "./bookingEmails.js";
import {
  canIssueBookingEmailDispatchToken,
  issueBookingEmailDispatchToken,
} from "./bookingEmailDispatchToken.js";

const writeClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const OWNER_TZ_NAME = "Asia/Kolkata";

const parseUtcDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const formatInTimeZone = (utcDate, timeZone, options = {}) => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      ...(timeZone ? { timeZone } : {}),
    }).format(utcDate);
  } catch (err) {
    console.error("Failed to format date in zone", err);
    return "";
  }
};

const formatOwnerDateLabel = (utcDate, timeZone = OWNER_TZ_NAME) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "2-digit",
      year: "numeric",
    })
      .formatToParts(utcDate)
      .reduce((acc, cur) => {
        acc[cur.type] = cur.value;
        return acc;
      }, {});

    const day = parts.day || "";
    const weekday = parts.weekday || "";
    const month = parts.month || "";
    const year = parts.year || "";

    return `${weekday} ${month} ${day} ${year}`.trim();
  } catch (err) {
    console.error("Failed to format owner date label", err);
    return "";
  }
};

const formatOwnerTimeLabel = (utcDate, timeZone = OWNER_TZ_NAME) =>
  formatInTimeZone(utcDate, timeZone, {
    hour: "numeric",
    minute: "2-digit",
  });

const formatClientDateLabel = (utcDate, timeZone) =>
  formatInTimeZone(utcDate, timeZone, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

const formatClientTimeLabel = (utcDate, timeZone) =>
  formatInTimeZone(utcDate, timeZone, {
    hour: "numeric",
    minute: "2-digit",
  });

const toMoney = (value) => {
  const parsed = Number(
    typeof value === "string" ? value.replace(/[^0-9.]/g, "") : value
  );
  if (!Number.isFinite(parsed)) return 0;
  return +parsed.toFixed(2);
};

const clampPercent = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, parsed));
};

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const buildBookingSuccessResponse = ({
  bookingId = "",
  emailDispatch = null,
  emailDispatchToken = "",
  idempotent = false,
}) => {
  const body = {
    bookingId,
  };

  if (idempotent) {
    body.idempotent = true;
  }

  if (emailDispatch) {
    body.emailDispatch = emailDispatch;
  }

  if (emailDispatchToken) {
    body.emailDispatchToken = emailDispatchToken;
  }

  return body;
};

const resolveIsProdLike = () => {
  const vercelEnv = String(process.env.VERCEL_ENV || "").toLowerCase();
  if (vercelEnv) return vercelEnv === "production";
  return process.env.NODE_ENV === "production";
};

const isProdLike = resolveIsProdLike();
const isTestEnv = process.env.NODE_ENV === "test";
const DEFAULT_RAZORPAY_CURRENCY = String(
  process.env.RAZORPAY_CURRENCY || "USD"
)
  .trim()
  .toUpperCase() || "USD";
const DEFAULT_PAYPAL_CURRENCY = String(process.env.PAYPAL_CURRENCY || "USD")
  .trim()
  .toUpperCase() || "USD";

const toSubunits = (amount, currency = "USD") => {
  const factors = { USD: 100, INR: 100, JPY: 1 };
  const factor = factors[currency] ?? 100;
  return Math.round(amount * factor);
};

const verifyRazorpaySignature = ({
  orderId,
  paymentId,
  signature,
  secret,
}) => {
  const payload = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return (
    signature?.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
};

const verifyRazorpayPayment = async ({
  orderId,
  paymentId,
  expectedAmount,
  expectedCurrency = "USD",
}) => {
  try {
    const keyId = process.env.RAZORPAY_KEY_ID || "";
    const keySecret = process.env.RAZORPAY_KEY_SECRET || "";

    if (!keyId || !keySecret) {
      return { ok: false, reason: "razorpay_credentials_missing" };
    }

    const basic = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const response = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`,
      {
        headers: {
          Authorization: `Basic ${basic}`,
        },
      }
    );

    if (!response.ok) {
      return { ok: false, reason: `razorpay_lookup_failed_${response.status}` };
    }

    const payment = await response.json();
    const status = String(payment?.status || "").toLowerCase();
    const paidAmount = Number(payment?.amount || 0);
    const expectedSubunits = toSubunits(expectedAmount, expectedCurrency);

    if (payment?.order_id !== orderId) {
      return { ok: false, reason: "razorpay_order_mismatch" };
    }

    if (payment?.currency !== expectedCurrency) {
      return { ok: false, reason: "razorpay_currency_mismatch" };
    }

    if (status !== "captured") {
      return { ok: false, reason: `razorpay_status_${status || "unknown"}` };
    }

    if (paidAmount !== expectedSubunits) {
      return { ok: false, reason: "razorpay_amount_mismatch" };
    }

    return { ok: true };
  } catch (error) {
    console.error("Razorpay lookup failed:", error);
    return { ok: false, reason: "razorpay_lookup_exception" };
  }
};

const getPayPalMode = () => {
  const explicit = String(
    process.env.PAYPAL_ENV || process.env.NEXT_PUBLIC_PAYPAL_ENV || ""
  )
    .trim()
    .toLowerCase();

  if (explicit === "live" || explicit === "production") return "live";
  if (explicit === "sandbox" || explicit === "test") return "sandbox";
  return isProdLike ? "live" : "sandbox";
};

const getPayPalBaseUrl = () =>
  getPayPalMode() === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

const getPayPalCredentials = () => {
  const clientId =
    process.env.PAYPAL_CLIENT_ID ||
    process.env.REACT_APP_PAYPAL_CLIENT_ID ||
    process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ||
    "";
  const clientSecret =
    process.env.PAYPAL_CLIENT_SECRET ||
    process.env.REACT_APP_PAYPAL_CLIENT_SECRET ||
    "";

  return { clientId, clientSecret };
};

const getPayPalToken = async () => {
  const { clientId, clientSecret } = getPayPalCredentials();
  if (!clientId || !clientSecret) {
    return { ok: false, reason: "paypal_credentials_missing", token: "" };
  }

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) {
      return { ok: false, reason: `paypal_token_failed_${response.status}`, token: "" };
    }
    const data = await response.json();
    const token = String(data?.access_token || "").trim();
    if (!token) {
      return { ok: false, reason: "paypal_token_missing", token: "" };
    }
    return { ok: true, reason: "", token };
  } catch (error) {
    console.error("PayPal token lookup failed:", error);
    return { ok: false, reason: "paypal_token_exception", token: "" };
  }
};

const verifyPayPalOrder = async ({
  orderId,
  expectedAmount,
  expectedCurrency = "USD",
}) => {
  const tokenResult = await getPayPalToken();
  if (!tokenResult.ok) {
    return { ok: false, reason: tokenResult.reason || "paypal_credentials_missing" };
  }

  try {
    const response = await fetch(
      `${getPayPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      {
        headers: {
          Authorization: `Bearer ${tokenResult.token}`,
        },
      }
    );

    if (!response.ok) {
      return { ok: false, reason: `paypal_lookup_failed_${response.status}` };
    }

    const details = await response.json();
    const status = String(details?.status || "").toUpperCase();
    if (status !== "COMPLETED") {
      return { ok: false, reason: `paypal_status_${status || "unknown"}` };
    }

    const captureAmount =
      details?.purchase_units?.[0]?.payments?.captures?.[0]?.amount ||
      details?.purchase_units?.[0]?.amount ||
      null;
    const paidAmount = toMoney(captureAmount?.value || 0) || 0;
    const paidCurrency = String(captureAmount?.currency_code || "")
      .trim()
      .toUpperCase();

    if (Math.abs(paidAmount - expectedAmount) > 0.01) {
      return { ok: false, reason: "paypal_amount_mismatch" };
    }

    if (paidCurrency !== String(expectedCurrency || "USD").trim().toUpperCase()) {
      return { ok: false, reason: "paypal_currency_mismatch" };
    }

    return {
      ok: true,
      payerEmail: details?.payer?.email_address || "",
    };
  } catch (error) {
    console.error("PayPal order lookup failed:", error);
    return { ok: false, reason: "paypal_lookup_exception" };
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      discord,
      email,
      specs,
      mainGame,
      message,
      packageTitle,
      packagePrice,
      status = "pending",
      referralId,
      referralCode,
      paypalOrderId = "",
      payerEmail = "",
      razorpayOrderId = "",
      razorpayPaymentId = "",
      razorpaySignature = "",
      originalOrderId = "",
      couponCode = "",
      localTimeZone,
      startTimeUTC,
      displayDate,
      displayTime,
      slotHoldId = "",
      slotHoldToken = "",
      paymentProvider = "",
      deferEmailsUntilConfirmation = false,
    } = req.body || {};
    const isUpgrade = !!originalOrderId;
    const clientAddress = getClientAddress(req);
    const rateLimitKeyParts = [
      "create-booking",
      clientAddress,
      String(paymentProvider || "").trim().toLowerCase(),
      String(originalOrderId || "").trim().toLowerCase(),
      String(startTimeUTC || "").trim().toLowerCase(),
      String(paypalOrderId || "").trim().toLowerCase(),
      String(razorpayPaymentId || "").trim().toLowerCase(),
    ];

    if (
      !requireRateLimit(res, {
        key: rateLimitKeyParts.join(":"),
        max: 10,
        message: "Too many booking attempts. Please try again later.",
      })
    ) {
      return;
    }

    let originalBooking = null;
    let upgradeContext = null;
    if (isUpgrade) {
      const normalizedUpgradeEmail = normalizeEmail(email);
      if (!normalizedUpgradeEmail) {
        return res.status(403).json({
          error: "Upgrade details do not match the original booking.",
        });
      }

      upgradeContext = await resolveUpgradeContext({
        originalOrderId,
        packageTitle,
        client: writeClient,
      });
      originalBooking = upgradeContext.booking;
      const allowedUpgradeEmails = [originalBooking.email, originalBooking.payerEmail]
        .map(normalizeEmail)
        .filter(Boolean);

      if (
        allowedUpgradeEmails.length > 0 &&
        !allowedUpgradeEmails.includes(normalizedUpgradeEmail)
      ) {
        return res.status(403).json({
          error: "Upgrade details do not match the original booking.",
        });
      }
    }

    const resolvedDiscord = String(
      discord || originalBooking?.discord || ""
    ).trim();
    const resolvedEmail = String(
      email || originalBooking?.email || originalBooking?.payerEmail || ""
    ).trim();
    const resolvedSpecs = String(
      specs || originalBooking?.specs || ""
    ).trim();
    const resolvedMainGame = String(
      mainGame || originalBooking?.mainGame || ""
    ).trim();
    const resolvedMessage = String(
      message || originalBooking?.message || ""
    ).trim();
    const resolvedLocalTimeZone = String(
      localTimeZone || originalBooking?.localTimeZone || ""
    ).trim();
    const resolvedStartTimeUTC =
      startTimeUTC || originalBooking?.startTimeUTC || "";
    const resolvedDisplayDate =
      displayDate || originalBooking?.displayDate || "";
    const resolvedDisplayTime =
      displayTime || originalBooking?.displayTime || "";

    if (!paymentProvider) {
      return res
        .status(400)
        .json({ error: "Missing payment provider on booking request." });
    }

    if (
      paymentProvider !== "free" &&
      paymentProvider !== "paypal" &&
      paymentProvider !== "razorpay"
    ) {
      return res.status(400).json({ error: "Unsupported payment provider." });
    }

    const deferEmailDispatchRequested = deferEmailsUntilConfirmation === true;
    const respondWithStoredBooking = async ({ bookingId, idempotent = false }) => {
      const normalizedBookingId = String(bookingId || "").trim();
      if (!normalizedBookingId) {
        return res
          .status(200)
          .json(buildBookingSuccessResponse({ bookingId, idempotent }));
      }

      const booking = await getBookingForEmailDispatch({
        bookingId: normalizedBookingId,
        client: writeClient,
      });

      if (!booking?._id) {
        return res
          .status(200)
          .json(buildBookingSuccessResponse({ bookingId, idempotent }));
      }

      const allEmailsAlreadySent =
        !!booking.emailDispatchClientSentAt && !!booking.emailDispatchOwnerSentAt;

      if (
        deferEmailDispatchRequested &&
        canIssueBookingEmailDispatchToken() &&
        !allEmailsAlreadySent
      ) {
        const queuedAt = booking.emailDispatchQueuedAt || new Date().toISOString();
        const patchValues = {
          emailDispatchDeferred: true,
          emailDispatchStatus: "pending",
          emailDispatchQueuedAt: queuedAt,
          emailDispatchLastError: "",
        };
        const patchedBooking =
          (await writeClient
            .patch(booking._id)
            .set(patchValues)
            .commit()) || {
            ...booking,
            ...patchValues,
          };

        return res.status(200).json(
          buildBookingSuccessResponse({
            bookingId: booking._id,
            idempotent,
            emailDispatch: buildDeferredEmailDispatch({
              booking: patchedBooking,
            }),
            emailDispatchToken: issueBookingEmailDispatchToken({
              bookingId: booking._id,
              email: String(
                patchedBooking.email || patchedBooking.payerEmail || ""
              ).trim(),
            }),
          })
        );
      }

      const sendResult = await sendBookingEmailsForBooking({
        bookingId: booking._id,
        booking,
        client: writeClient,
      });

      return res.status(sendResult.httpStatus).json(
        buildBookingSuccessResponse({
          bookingId: booking._id,
          idempotent,
          emailDispatch: sendResult.body?.emailDispatch || null,
        })
      );
    };

    if (paymentProvider === "free") {
      if (status !== "captured") {
        return res.status(400).json({
          error: "Free bookings must have status 'captured'.",
        });
      }

      if (!couponCode) {
        return res.status(400).json({
          error: "Free bookings require a valid coupon code.",
        });
      }

      const freeCoupon = await writeClient.fetch(
        `*[_type == "coupon" && lower(code) == $code][0]{
          _id,
          isActive,
          timesUsed,
          maxUses,
          discountPercent
        }`,
        { code: String(couponCode).toLowerCase() }
      );

      if (!freeCoupon) {
        return res.status(400).json({
          error: "Coupon not found or inactive for free booking.",
        });
      }

      const currentUsed = freeCoupon.timesUsed ?? 0;
      const maxUses = freeCoupon.maxUses;

      if (
        freeCoupon.isActive === false ||
        (typeof maxUses === "number" && maxUses > 0 && currentUsed >= maxUses)
      ) {
        return res.status(400).json({
          error: "This coupon can no longer be used for free bookings.",
        });
      }

      if (
        typeof freeCoupon.discountPercent === "number" &&
        freeCoupon.discountPercent < 100
      ) {
        return res.status(400).json({
          error: "This coupon does not provide a full (100%) discount.",
        });
      }
    }

    if (paymentProvider === "paypal" || paymentProvider === "razorpay") {
      if (status !== "captured") {
        return res.status(400).json({
          error: "Only captured payments can create bookings.",
        });
      }
    }

    if (status === "captured" && paymentProvider !== "free") {
      const hasPaypalProof = !!paypalOrderId;
      const hasRazorpayProof = !!razorpayPaymentId;

      if (!hasPaypalProof && !hasRazorpayProof) {
        return res.status(400).json({
          error:
            "Payment verification missing. Cannot mark booking as paid without a transaction ID.",
        });
      }
    }

    if (paymentProvider === "paypal" && paypalOrderId) {
      const existingByPaypal = await writeClient.fetch(
        `*[_type == "booking" && paypalOrderId == $paypalOrderId][0]{_id}`,
        { paypalOrderId }
      );
      if (existingByPaypal?._id) {
        return respondWithStoredBooking({
          bookingId: existingByPaypal._id,
          idempotent: true,
        });
      }
    }

    if (paymentProvider === "razorpay" && razorpayPaymentId) {
      const existingByRazorpay = await writeClient.fetch(
        `*[_type == "booking" && razorpayPaymentId == $razorpayPaymentId][0]{_id}`,
        { razorpayPaymentId }
      );
      if (existingByRazorpay?._id) {
        return respondWithStoredBooking({
          bookingId: existingByRazorpay._id,
          idempotent: true,
        });
      }
    }

    const utcDate = parseUtcDate(resolvedStartTimeUTC);
    if (!utcDate) {
      return res.status(400).json({
        error: "Missing or invalid startTimeUTC.",
      });
    }

    const normalizedStartTimeUTC = utcDate.toISOString();
    const bookingDocId = !isUpgrade
      ? buildSlotBookingId(normalizedStartTimeUTC)
      : "";
    const expectedHoldId = !isUpgrade
      ? buildSlotHoldId(normalizedStartTimeUTC)
      : "";
    const ownerDate = formatOwnerDateLabel(utcDate);
    const ownerTime = formatOwnerTimeLabel(utcDate);

    if (!ownerDate || !ownerTime) {
      return res.status(400).json({
        error: "Missing booking date/time.",
      });
    }

    const clientTimeZone = resolvedLocalTimeZone;
    const clientDate =
      resolvedDisplayDate ||
      (clientTimeZone ? formatClientDateLabel(utcDate, clientTimeZone) : "");
    const clientTime =
      resolvedDisplayTime ||
      (clientTimeZone ? formatClientTimeLabel(utcDate, clientTimeZone) : "");

    const bookingDate = ownerDate;
    const bookingTime = ownerTime;

    if (!clientDate || !clientTime) {
      return res.status(400).json({
        error: "Missing client booking date/time.",
      });
    }

    let holdDoc = null;
    let fetchActiveHold = null;
    let holdUtcIso = "";
    let slotReservationState = isUpgrade ? "upgrade" : "hold_active";
    const isCapturedPaidPayment =
      status === "captured" &&
      (paymentProvider === "paypal" || paymentProvider === "razorpay");

    if (!isUpgrade) {
      const existingBooking = await writeClient.fetch(
        `*[_type == "booking" && hostDate == $date && hostTime == $time][0]`,
        { date: bookingDate, time: bookingTime }
      );

      if (existingBooking) {
        return res.status(409).json({
          error: "This slot is already booked.",
        });
      }

      fetchActiveHold = () =>
        writeClient.fetch(
          `*[_type == "slotHold"
              && hostDate == $date
              && hostTime == $time
              && expiresAt > now()][0]`,
          { date: bookingDate, time: bookingTime }
        );

      if (!slotHoldId || !slotHoldToken) {
        return res
          .status(409)
          .json({ error: "Your slot reservation expired." });
      }

      holdDoc = await writeClient.fetch(
        `*[_type == "slotHold" && _id == $id][0]`,
        { id: slotHoldId }
      );

      if (!holdDoc) {
        if (slotHoldId !== expectedHoldId) {
          return res.status(400).json({
            error: "Slot hold does not match selected time.",
          });
        }
      } else {
        const holdUtc = parseUtcDate(holdDoc.startTimeUTC);
        holdUtcIso = holdUtc ? holdUtc.toISOString() : "";
        if (
          (holdUtcIso && holdUtcIso !== normalizedStartTimeUTC) ||
          (!holdUtcIso &&
            (holdDoc.hostDate !== bookingDate ||
              holdDoc.hostTime !== bookingTime))
        ) {
          return res.status(400).json({
            error: "Slot hold does not match selected time.",
          });
        }
      }
    }

    const {
      couponDiscountAmount,
      couponDiscountPercent,
      couponDoc,
      effectiveCommissionPercent,
      effectiveDiscountAmount,
      effectiveDiscountPercent,
      effectiveGrossAmount,
      effectiveNetAmount,
      effectiveReferralCode,
      effectiveReferralId,
      commissionAmount,
    } = await resolveBookingPricing({
      packageTitle,
      originalOrderId,
      referralId,
      referralCode,
      couponCode,
      paymentProvider,
      client: writeClient,
      upgradeContext,
    });
    const resolvedPackagePrice = `$${effectiveGrossAmount.toFixed(2)}`;

    let verifiedPayerEmail = payerEmail;

    if (paymentProvider === "razorpay") {
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return res.status(400).json({
          error: "Missing payment verification fields.",
        });
      }

      const razorpayKeyId = process.env.RAZORPAY_KEY_ID || "";
      const razorpaySecret = process.env.RAZORPAY_KEY_SECRET || "";
      const hasRazorpayCreds = !!razorpayKeyId && !!razorpaySecret;
      if (!hasRazorpayCreds && !isTestEnv) {
        return res.status(500).json({
          error: "Payment verification is temporarily unavailable.",
        });
      }

      if (hasRazorpayCreds) {
        const validSignature = verifyRazorpaySignature({
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
          signature: razorpaySignature,
          secret: razorpaySecret,
        });
        if (!validSignature) {
          return res.status(400).json({ error: "Payment verification failed." });
        }

        const paymentVerification = await verifyRazorpayPayment({
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
          expectedAmount: effectiveNetAmount,
          expectedCurrency: DEFAULT_RAZORPAY_CURRENCY,
        });

        if (!paymentVerification.ok) {
          console.warn("Razorpay verification rejected", {
            orderId: razorpayOrderId,
            paymentId: razorpayPaymentId,
            reason: paymentVerification.reason || "unknown",
          });
          return res.status(400).json({
            error: "Payment verification failed.",
          });
        }
      }
    }

    if (paymentProvider === "paypal") {
      if (!paypalOrderId) {
        return res.status(400).json({
          error: "Missing payment verification fields.",
        });
      }

      const { clientId: paypalClientId, clientSecret: paypalClientSecret } =
        getPayPalCredentials();
      const hasPayPalCreds = !!paypalClientId && !!paypalClientSecret;
      if (!hasPayPalCreds && !isTestEnv) {
        return res.status(500).json({
          error: "Payment verification is temporarily unavailable.",
        });
      }

      if (hasPayPalCreds) {
        const paypalVerification = await verifyPayPalOrder({
          orderId: paypalOrderId,
          expectedAmount: effectiveNetAmount,
          expectedCurrency: DEFAULT_PAYPAL_CURRENCY,
        });
        if (!paypalVerification.ok) {
          console.warn("PayPal verification rejected", {
            orderId: paypalOrderId,
            reason: paypalVerification.reason || "unknown",
          });
          return res.status(400).json({
            error: "Payment verification failed.",
          });
        }
        if (paypalVerification.payerEmail) {
          verifiedPayerEmail = paypalVerification.payerEmail;
        }
      }
    }

    if (!isUpgrade) {
      const signedHoldToken = verifyHoldToken({
        token: slotHoldToken,
        holdId: slotHoldId,
        startTimeUTC: holdUtcIso || normalizedStartTimeUTC,
        holdNonce: holdDoc?.holdNonce || "",
      });
      const signedExpiredHoldToken = verifyHoldToken({
        token: slotHoldToken,
        holdId: slotHoldId,
        startTimeUTC: holdUtcIso || normalizedStartTimeUTC,
        holdNonce: holdDoc?.holdNonce || "",
        ignoreExpiry: true,
      });
      const activeHold = fetchActiveHold ? await fetchActiveHold() : null;
      const hasActiveReplacementHold =
        !!holdDoc &&
        !!activeHold &&
        !signedHoldToken &&
        activeHold._id === slotHoldId;
      const holdExpired =
        !!holdDoc?.expiresAt && new Date(holdDoc.expiresAt) <= new Date();

      if (signedHoldToken) {
        slotReservationState = "hold_active";
      } else if (
        isCapturedPaidPayment &&
        signedExpiredHoldToken &&
        !activeHold &&
        (!holdDoc || holdExpired)
      ) {
        slotReservationState = holdDoc
          ? "reconciled_after_expired_hold"
          : "reconciled_after_missing_hold";
      } else if (hasActiveReplacementHold) {
        return res.status(409).json({
          error: "This slot is temporarily reserved by another user.",
        });
      } else if (holdExpired || !holdDoc) {
        return res.status(409).json({
          error: "Your slot reservation expired.",
        });
      } else {
        return res.status(403).json({
          error: "This slot reservation is not valid for your session.",
        });
      }
    }

    let doc;
    try {
      doc = await writeClient.create({
        ...(bookingDocId ? { _id: bookingDocId } : {}),
        _type: "booking",
        date: bookingDate,
        time: bookingTime,
        discord: resolvedDiscord,
        email: resolvedEmail,
        specs: resolvedSpecs,
        mainGame: resolvedMainGame,
        message: resolvedMessage,
        packageTitle,
        packagePrice: resolvedPackagePrice,
        status,
        paymentProvider,
        paypalOrderId,
        payerEmail: verifiedPayerEmail,
        razorpayOrderId,
        razorpayPaymentId,
        referralCode: effectiveReferralCode,
        discountPercent: effectiveDiscountPercent,
        discountAmount: effectiveDiscountAmount,
        grossAmount: effectiveGrossAmount,
        netAmount: effectiveNetAmount,
        commissionPercent: effectiveCommissionPercent,
        commissionAmount,
        hostDate: bookingDate,
        hostTime: bookingTime,
        hostTimeZone: OWNER_TZ_NAME,
        localTimeZone: clientTimeZone,
        localTimeLabel: clientTime,
        startTimeUTC: normalizedStartTimeUTC,
        displayDate: clientDate,
        displayTime: clientTime,
        ...(slotReservationState
          ? { slotReservationState }
          : {}),
        ...(originalOrderId ? { originalOrderId } : {}),
        ...(couponCode
          ? {
              couponCode,
              couponDiscountPercent,
              couponDiscountAmount,
            }
          : {}),
        ...(effectiveReferralId
          ? { referral: { _type: "reference", _ref: effectiveReferralId } }
          : {}),
      });
    } catch (createError) {
      const statusCode =
        Number(createError?.statusCode || createError?.status || 0) || 0;
      if (bookingDocId && statusCode === 409) {
        const existingBooking = await writeClient.fetch(
          `*[_type == "booking" && hostDate == $date && hostTime == $time][0]{
            _id,
            paymentProvider,
            paypalOrderId,
            razorpayPaymentId
          }`,
          { date: bookingDate, time: bookingTime }
        );

        if (existingBooking?._id) {
          const samePaypalProof =
            paymentProvider === "paypal" &&
            !!paypalOrderId &&
            existingBooking.paypalOrderId === paypalOrderId;
          const sameRazorpayProof =
            paymentProvider === "razorpay" &&
            !!razorpayPaymentId &&
            existingBooking.razorpayPaymentId === razorpayPaymentId;

          if (samePaypalProof || sameRazorpayProof) {
            return respondWithStoredBooking({
              bookingId: existingBooking._id,
              idempotent: true,
            });
          }
        }

        return res.status(409).json({
          error: "This slot is already booked.",
        });
      }
      throw createError;
    }

    try {
      await writeClient
        .patch(doc._id)
        .setIfMissing({ orderId: doc._id })
        .commit();
    } catch (err) {
      console.error("Failed to set booking orderId:", err);
    }

    if (!isUpgrade && slotHoldId) {
      try {
        await writeClient.delete(slotHoldId);
      } catch {}
    }

    if (effectiveReferralId && status === "captured") {
      try {
        await writeClient
          .patch(effectiveReferralId)
          .inc({ successfulReferrals: 1 })
          .commit();
      } catch {}
    }

    if (couponCode && status === "captured") {
      try {
        const couponDoc = await writeClient.fetch(
          `*[_type == "coupon" && lower(code) == $code][0]{
            _id, timesUsed, maxUses
          }`,
          { code: couponCode.toLowerCase() }
        );

        if (couponDoc) {
          const currentUsed = couponDoc.timesUsed ?? 0;
          const max = couponDoc.maxUses;

          const patch = writeClient.patch(couponDoc._id).inc({
            timesUsed: 1,
          });

          if (typeof max === "number" && max > 0 && currentUsed + 1 >= max) {
            patch.set({ isActive: false });
          }

          await patch.commit();
        }
      } catch {}
    }

    if (deferEmailDispatchRequested && canIssueBookingEmailDispatchToken()) {
      const queuedAt = new Date().toISOString();
      const deferredPatchValues = {
        emailDispatchDeferred: true,
        emailDispatchStatus: "pending",
        emailDispatchQueuedAt: queuedAt,
        emailDispatchLastError: "",
      };
      const deferredBooking =
        (await writeClient
          .patch(doc._id)
          .set(deferredPatchValues)
          .commit()) || {
          ...doc,
          ...deferredPatchValues,
        };

      return res.status(200).json(
        buildBookingSuccessResponse({
          bookingId: doc._id,
          emailDispatch: buildDeferredEmailDispatch({
            booking: deferredBooking,
          }),
          emailDispatchToken: issueBookingEmailDispatchToken({
            bookingId: doc._id,
            email: String(
              deferredBooking.email || deferredBooking.payerEmail || ""
            ).trim(),
          }),
        })
      );
    }

    const sendResult = await sendBookingEmailsForBooking({
      bookingId: doc._id,
      booking: doc,
      client: writeClient,
    });

    return res.status(sendResult.httpStatus).json(
      buildBookingSuccessResponse({
        bookingId: doc._id,
        emailDispatch: sendResult.body?.emailDispatch || null,
      })
    );
  } catch (err) {
    const message = err?.message || "Server error";
    const code = err?.code;
    const status = Number(err?.status) || 500;
    console.error("Booking API error:", { message, code });
    return res.status(status).json({ error: message });
  }
}
