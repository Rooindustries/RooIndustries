import { createClient } from "@sanity/client";
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
import providerConfig from "../payment/providerConfig.js";
import {
  DEFAULT_PAYPAL_CURRENCY,
  DEFAULT_RAZORPAY_CURRENCY,
  getPayPalCredentials,
  resolveRazorpayCredentials,
  verifyPayPalOrder,
  verifyRazorpayPayment,
  verifyRazorpaySignature,
} from "../payment/providerClients.js";
import {
  buildBookingSeedKey,
  buildPaymentRecordEvent,
  buildPaymentRecordId,
  buildPricingFingerprint,
  mergePaymentRecordEvents,
  PAYMENT_RECORD_TYPE,
  PAYMENT_STATUS_BOOKED,
  PAYMENT_STATUS_EMAIL_PARTIAL,
} from "../payment/paymentRecord.js";

const { resolvePaymentProviders } = providerConfig;

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

const toMoney = (value) => {
  const parsed = Number(
    typeof value === "string" ? value.replace(/[^0-9.]/g, "") : value
  );
  if (!Number.isFinite(parsed)) return 0;
  return +parsed.toFixed(2);
};

const resolvePaymentRecordStatus = (emailDispatch = {}) =>
  emailDispatch?.allSent === false
    ? PAYMENT_STATUS_EMAIL_PARTIAL
    : PAYMENT_STATUS_BOOKED;

const findPaymentRecordForBooking = async ({
  client,
  paymentRecordId = "",
  paymentProvider = "",
  paypalOrderId = "",
  razorpayOrderId = "",
  razorpayPaymentId = "",
}) => {
  if (paymentRecordId) {
    const byId = await client.fetch(
      `*[_type == $type && _id == $id][0]`,
      { type: PAYMENT_RECORD_TYPE, id: paymentRecordId }
    );
    if (byId?._id) return byId;
  }

  if (paymentProvider === "paypal" && paypalOrderId) {
    return client.fetch(
      `*[_type == $type && provider == "paypal" && providerOrderId == $providerOrderId][0]`,
      {
        type: PAYMENT_RECORD_TYPE,
        providerOrderId: paypalOrderId,
      }
    );
  }

  if (paymentProvider === "razorpay" && razorpayPaymentId) {
    return client.fetch(
      `*[_type == $type && provider == "razorpay" && providerPaymentId == $providerPaymentId][0]`,
      {
        type: PAYMENT_RECORD_TYPE,
        providerPaymentId: razorpayPaymentId,
      }
    );
  }

  if (paymentProvider === "razorpay" && razorpayOrderId) {
    return client.fetch(
      `*[_type == $type && provider == "razorpay" && providerOrderId == $providerOrderId][0]`,
      {
        type: PAYMENT_RECORD_TYPE,
        providerOrderId: razorpayOrderId,
      }
    );
  }

  return null;
};

const isTestEnv = process.env.NODE_ENV === "test";
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
      slotHoldExpiresAt = "",
      paymentProvider = "",
      paymentRecordId = "",
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

    const availableProviders = isTestEnv ? null : resolvePaymentProviders();
    if (!isTestEnv && paymentProvider === "paypal") {
      if (
        !availableProviders?.paypal?.enabled ||
        !String(availableProviders?.paypal?.clientId || "").trim()
      ) {
        return res.status(400).json({
          error: "PayPal is not available in this environment.",
        });
      }
    }

    if (
      !isTestEnv &&
      paymentProvider === "razorpay" &&
      !availableProviders?.razorpay?.enabled
    ) {
      return res.status(400).json({
        error: "Razorpay is not available in this environment.",
      });
    }

    const deferEmailDispatchRequested = deferEmailsUntilConfirmation === true;
    const syncPaidPaymentRecordForBooking = async ({
      bookingId,
      emailDispatch = null,
      emailDispatchToken = "",
      source = "legacy",
    }) => {
      const normalizedBookingId = String(bookingId || "").trim();
      const normalizedProvider = String(paymentProvider || "").trim().toLowerCase();
      if (
        !normalizedBookingId ||
        (normalizedProvider !== "paypal" && normalizedProvider !== "razorpay")
      ) {
        return null;
      }

      const bookingDoc = await writeClient.fetch(
        `*[_type == "booking" && _id == $id][0]`,
        { id: normalizedBookingId }
      );
      if (!bookingDoc?._id) {
        return null;
      }

      const existingRecord = await findPaymentRecordForBooking({
        client: writeClient,
        paymentRecordId,
        paymentProvider: normalizedProvider,
        paypalOrderId:
          String(bookingDoc.paypalOrderId || paypalOrderId || "").trim(),
        razorpayOrderId:
          String(bookingDoc.razorpayOrderId || razorpayOrderId || "").trim(),
        razorpayPaymentId: String(
          bookingDoc.razorpayPaymentId || razorpayPaymentId || ""
        ).trim(),
      });

      const bookingSeedKey = buildBookingSeedKey({
        provider: normalizedProvider,
        packageTitle: bookingDoc.packageTitle || packageTitle || "",
        originalOrderId: bookingDoc.originalOrderId || originalOrderId || "",
        startTimeUTC: bookingDoc.startTimeUTC || resolvedStartTimeUTC || "",
        email: bookingDoc.email || bookingDoc.payerEmail || resolvedEmail || "",
      });
      const providerOrderId = String(
        bookingDoc.paypalOrderId ||
          bookingDoc.razorpayOrderId ||
          paypalOrderId ||
          razorpayOrderId ||
          ""
      ).trim();
      const providerPaymentId = String(
        bookingDoc.razorpayPaymentId || razorpayPaymentId || ""
      ).trim();
      const resolvedGrossAmount = Number(
        bookingDoc.grossAmount || toMoney(bookingDoc.packagePrice || packagePrice)
      );
      const resolvedNetAmount = Number(
        bookingDoc.netAmount || toMoney(bookingDoc.packagePrice || packagePrice)
      );
      const resolvedDiscountAmount = Number(bookingDoc.discountAmount || 0);
      const resolvedDiscountPercent = Number(bookingDoc.discountPercent || 0);
      const resolvedCommissionPercent = Number(bookingDoc.commissionPercent || 0);
      const resolvedCouponDiscountPercent = Number(
        bookingDoc.couponDiscountPercent || 0
      );
      const resolvedCouponDiscountAmount = Number(
        bookingDoc.couponDiscountAmount || 0
      );
      const resolvedReferralCode = String(
        bookingDoc.referralCode || referralCode || ""
      ).trim();
      const resolvedReferralId = String(
        bookingDoc.referralId || referralId || ""
      ).trim();
      const pricingFingerprint = buildPricingFingerprint({
        provider: normalizedProvider,
        packageTitle: bookingDoc.packageTitle || packageTitle || "",
        originalOrderId: bookingDoc.originalOrderId || originalOrderId || "",
        startTimeUTC: bookingDoc.startTimeUTC || resolvedStartTimeUTC || "",
        email: bookingDoc.email || bookingDoc.payerEmail || resolvedEmail || "",
        grossAmount: resolvedGrossAmount,
        netAmount: resolvedNetAmount,
        discountAmount: resolvedDiscountAmount,
        referralId: resolvedReferralId,
        referralCode: resolvedReferralCode,
        couponCode: bookingDoc.couponCode || couponCode || "",
        currency:
          normalizedProvider === "paypal"
            ? DEFAULT_PAYPAL_CURRENCY
            : DEFAULT_RAZORPAY_CURRENCY,
      });
      const resolvedEmailDispatch =
        emailDispatch ||
        buildDeferredEmailDispatch({
          booking: bookingDoc,
        });
      const nextStatus = resolvePaymentRecordStatus(resolvedEmailDispatch);
      const recordId =
        String(existingRecord?._id || paymentRecordId || "").trim() ||
        buildPaymentRecordId({
          provider: normalizedProvider,
          providerOrderId,
          providerPaymentId,
          bookingSeedKey,
        });
      const now = new Date().toISOString();
      const nextEvent = buildPaymentRecordEvent({
        status: nextStatus,
        source,
        data: {
          bookingId: normalizedBookingId,
          providerOrderId,
          providerPaymentId,
        },
      });
      const doc = {
        _id: recordId,
        _type: PAYMENT_RECORD_TYPE,
        provider: normalizedProvider,
        status: nextStatus,
        bookingSeedKey,
        pricingFingerprint,
        bookingFinalizationKey:
          normalizedProvider === "paypal"
            ? `paypal:${providerOrderId}`
            : `razorpay-order:${providerOrderId}`,
        bookingPayload: {
          packageTitle: String(
            bookingDoc.packageTitle || packageTitle || ""
          ).trim(),
          originalOrderId: String(
            bookingDoc.originalOrderId || originalOrderId || ""
          ).trim(),
          startTimeUTC: String(
            bookingDoc.startTimeUTC || resolvedStartTimeUTC || ""
          ).trim(),
          email: String(
            bookingDoc.email || bookingDoc.payerEmail || resolvedEmail || ""
          ).trim(),
          localTimeZone: String(
            bookingDoc.localTimeZone || resolvedLocalTimeZone || ""
          ).trim(),
          displayDate: String(
            bookingDoc.displayDate || resolvedDisplayDate || ""
          ).trim(),
          displayTime: String(
            bookingDoc.displayTime || resolvedDisplayTime || ""
          ).trim(),
          referralCode: resolvedReferralCode,
          couponCode: String(bookingDoc.couponCode || couponCode || "").trim(),
          slotHoldId: String(slotHoldId || "").trim(),
          slotHoldToken: String(slotHoldToken || "").trim(),
          slotHoldExpiresAt: String(slotHoldExpiresAt || "").trim(),
          paymentProvider: normalizedProvider,
        },
        pricingSnapshot: {
          grossAmount: resolvedGrossAmount,
          discountAmount: resolvedDiscountAmount,
          discountPercent: resolvedDiscountPercent,
          netAmount: resolvedNetAmount,
          referralDiscountAmount: 0,
          referralDiscountPercent: 0,
          commissionPercent: resolvedCommissionPercent,
          couponDiscountPercent: resolvedCouponDiscountPercent,
          couponDiscountAmount: resolvedCouponDiscountAmount,
          canCombineWithReferral: false,
          effectiveReferralCode: resolvedReferralCode,
          effectiveReferralId: resolvedReferralId,
        },
        holdSnapshot: existingRecord?.holdSnapshot || {},
        providerOrderId,
        providerPaymentId,
        payerEmail: String(
          bookingDoc.payerEmail || payerEmail || resolvedEmail || ""
        ).trim(),
        verificationState: String(
          bookingDoc.paymentVerificationState || ""
        ).trim(),
        verificationWarning: String(
          bookingDoc.paymentVerificationWarning || ""
        ).trim(),
        bookingId: normalizedBookingId,
        recoveryReason: "",
        attemptCount: Number(existingRecord?.attemptCount || 0),
        lastAttemptAt: now,
        source,
        providerPublicData:
          existingRecord?.providerPublicData ||
          (normalizedProvider === "paypal"
            ? {
                orderId: providerOrderId,
                currency: DEFAULT_PAYPAL_CURRENCY,
                clientId: String(
                  availableProviders?.paypal?.clientId || ""
                ).trim(),
              }
            : {
                orderId: providerOrderId,
                currency: DEFAULT_RAZORPAY_CURRENCY,
                amount: Math.round(resolvedNetAmount * 100),
                key: String(
                  resolveRazorpayCredentials()?.keyId || ""
                ).trim(),
              }),
        emailDispatch: resolvedEmailDispatch,
        emailDispatchToken: String(emailDispatchToken || "").trim(),
        events: mergePaymentRecordEvents(existingRecord?.events || [], nextEvent),
        createdAt: existingRecord?.createdAt || now,
        updatedAt: now,
      };

      const recordSet = { ...doc };
      delete recordSet._id;
      delete recordSet._type;

      if (existingRecord?._id) {
        await writeClient
          .patch(existingRecord._id)
          .set(recordSet)
          .setIfMissing({
            _type: PAYMENT_RECORD_TYPE,
            createdAt: existingRecord.createdAt || now,
          })
          .commit();
        return writeClient.fetch(
          `*[_type == $type && _id == $id][0]`,
          { type: PAYMENT_RECORD_TYPE, id: existingRecord._id }
        );
      }

      try {
        await writeClient.create(doc);
      } catch (error) {
        const conflict =
          Number(error?.statusCode || error?.status || 0) === 409;
        if (!conflict) throw error;
        await writeClient
          .patch(recordId)
          .set(recordSet)
          .setIfMissing({
            _type: PAYMENT_RECORD_TYPE,
            createdAt: now,
          })
          .commit();
      }

      return writeClient.fetch(
        `*[_type == $type && _id == $id][0]`,
        { type: PAYMENT_RECORD_TYPE, id: recordId }
      );
    };
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
        const deferredEmailDispatch = buildDeferredEmailDispatch({
          booking: patchedBooking,
        });
        const deferredEmailDispatchToken = issueBookingEmailDispatchToken({
          bookingId: booking._id,
          email: String(
            patchedBooking.email || patchedBooking.payerEmail || ""
          ).trim(),
        });
        await syncPaidPaymentRecordForBooking({
          bookingId: booking._id,
          emailDispatch: deferredEmailDispatch,
          emailDispatchToken: deferredEmailDispatchToken,
          source: idempotent ? "legacy-idempotent" : "legacy",
        });

        return res.status(200).json(
          buildBookingSuccessResponse({
            bookingId: booking._id,
            idempotent,
            emailDispatch: deferredEmailDispatch,
            emailDispatchToken: deferredEmailDispatchToken,
          })
        );
      }

      const sendResult = await sendBookingEmailsForBooking({
        bookingId: booking._id,
        booking,
        client: writeClient,
      });
      await syncPaidPaymentRecordForBooking({
        bookingId: booking._id,
        emailDispatch: sendResult.body?.emailDispatch || null,
        source: idempotent ? "legacy-idempotent" : "legacy",
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

      const razorpayCredentials = resolveRazorpayCredentials();
      const razorpaySecret = razorpayCredentials.keySecret;
      const hasRazorpayCreds =
        !!razorpayCredentials.keyId && !!razorpayCredentials.keySecret;
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

    return respondWithStoredBooking({
      bookingId: doc._id,
      idempotent: false,
    });
  } catch (err) {
    const message = err?.message || "Server error";
    const code = err?.code;
    const status = Number(err?.status) || 500;
    console.error("Booking API error:", { message, code });
    return res.status(status).json({ error: message });
  }
}
