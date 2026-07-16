import { createDataClient as createClient } from "../../data/documentClient.js";
import { verifyHoldToken } from "../../booking/holdToken.js";
import { resolveBookingPricing, resolveUpgradeContext } from "./pricing.js";
import {
  buildDeterministicBookingId,
  buildSlotHoldId,
  isExactWholeMinute,
} from "../../booking/slotIdentity.js";
import {
  getBookingSettings,
  isBookingBlockingStatus,
  isSlotAllowedForPackage,
} from "../../booking/slotPolicy.js";
import { normalizeBookingStatus } from "../../booking/bookingStatus.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";
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
  PAYMENT_STATUS_REFUNDED,
} from "../payment/paymentRecord.js";
import { commitBookingTransaction } from "./bookingCommit.js";
import { reserveCouponUse } from "./couponReservations.js";
import {
  verifyFrozenUpgradeIntent,
  verifyUpgradeIntentToken,
} from "./upgradeIntentToken.js";

const { resolvePaymentProviders } = providerConfig;

const defaultWriteClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
}, { domain: "commerce" });

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
    logSafeError("Booking date formatting failed", err);
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
    logSafeError("Booking owner date formatting failed", err);
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
  const normalized =
    typeof value === "string"
      ? value.trim().replace(/,/g, "").replace(/[$€£₹]/g, "").trim()
      : value;
  if (
    typeof normalized === "string" &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)
  ) {
    return 0;
  }
  const parsed = Number(normalized);
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
const TRUSTED_PAYMENT_FINALIZE_SOURCES = new Set([
  "client",
  "webhook",
  "reconcile",
]);

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const writeClient = req.internalContext?.documentClient || defaultWriteClient;

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
      bookingRequestId = "",
      upgradeIntentToken = "",
      deferEmailsUntilConfirmation = false,
    } = req.body || {};
    const normalizedStatus = normalizeBookingStatus(status);
    if (!normalizedStatus) {
      return res.status(400).json({ error: "Invalid booking status." });
    }
    const isUpgrade = !!originalOrderId;
    const paymentFinalizeSource = String(
      req.internalContext?.paymentFinalizeSource || ""
    )
      .trim()
      .toLowerCase();
    const trustedPaymentFinalizeSource =
      TRUSTED_PAYMENT_FINALIZE_SOURCES.has(paymentFinalizeSource);
    const paymentProofClaimId = String(
      req.internalContext?.paymentProofClaimId || ""
    ).trim();
    const preparedPaymentProofClaim =
      req.internalContext?.paymentProofClaim &&
      typeof req.internalContext.paymentProofClaim === "object"
        ? req.internalContext.paymentProofClaim
        : null;
    const paymentFinalizationLeaseId = String(
      req.internalContext?.paymentFinalizationLeaseId || ""
    ).trim();
    const existingCouponReservationId = String(
      req.internalContext?.couponReservationId || ""
    ).trim();
    const emailDispatchAlreadyComplete =
      req.internalContext?.emailDispatchAlreadyComplete === true;
    const emailDispatchCompletedAt = String(
      req.internalContext?.emailDispatchCompletedAt || ""
    ).trim();
    const isInternalPaymentFinalization = !!req.internalContext && (
      !!paymentFinalizeSource || !!paymentProofClaimId || !!paymentFinalizationLeaseId
    );
    const preserveHistoricalAccounting =
      isInternalPaymentFinalization &&
      req.internalContext?.preserveHistoricalAccounting === true;
    const backendOwner =
      req.internalContext?.backendOwner === "supabase" ? "supabase" : "sanity";
    const legacyCompletionDeadline = new Date(
      process.env.PAYMENT_LEGACY_COMPLETION_UNTIL || ""
    ).getTime();
    const allowLegacyCompletion =
      isTestEnv ||
      (Number.isFinite(legacyCompletionDeadline) &&
        legacyCompletionDeadline > Date.now());
    const isLegacyPublicCompletion =
      !isInternalPaymentFinalization &&
      ["paypal", "razorpay", "free"].includes(paymentProvider);
    if (isLegacyPublicCompletion && !allowLegacyCompletion) {
      return res.status(410).json({
        error: "This checkout session expired. Please restart checkout.",
      });
    }
    const internalPaymentRecord = isInternalPaymentFinalization && paymentRecordId
      ? await writeClient.fetch(
          `*[_type == $type && _id == $id][0]{...}`,
          { type: PAYMENT_RECORD_TYPE, id: paymentRecordId }
        )
      : null;
    const cutoverGeneration = Math.max(
      0,
      Number(
        req.internalContext?.cutoverGeneration ??
          internalPaymentRecord?.cutoverGeneration ??
          0
      ) || 0
    );
    if (
      isInternalPaymentFinalization &&
      (!internalPaymentRecord?._id || internalPaymentRecord.provider !== paymentProvider)
    ) {
      return res.status(409).json({
        error: "Payment finalization record is no longer valid.",
      });
    }
    const clientAddress = getClientAddress(req);
    if (
      !isInternalPaymentFinalization &&
      !(await requireRateLimit(res, {
        key: `create-booking:${clientAddress}`,
        max: 30,
        message: "Too many booking attempts. Please try again later.",
      }))
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

      if (isInternalPaymentFinalization) {
        originalBooking = await writeClient.fetch(
          `*[_type == "booking" && _id == $id][0]{...}`,
          { id: originalOrderId }
        );
      } else {
        upgradeContext = await resolveUpgradeContext({
          originalOrderId,
          packageTitle,
          client: writeClient,
        });
        originalBooking = upgradeContext.booking;
      }
      if (isInternalPaymentFinalization) {
        const frozenIntentMatches = verifyFrozenUpgradeIntent({
          snapshot: internalPaymentRecord.upgradeIntentSnapshot,
          bookingId: originalOrderId,
          email: normalizedUpgradeEmail,
          targetPackageTitle: packageTitle,
        });
        if (!frozenIntentMatches) {
          return res.status(403).json({
            error: "The frozen upgrade authorization no longer matches.",
          });
        }
      } else {
        const mayOmitLegacyUpgradeIntent =
          isLegacyPublicCompletion && allowLegacyCompletion;
        if (!upgradeIntentToken && !mayOmitLegacyUpgradeIntent) {
          return res.status(403).json({
            error: "Upgrade authorization is required.",
          });
        }
      }
      if (!isInternalPaymentFinalization && upgradeIntentToken) {
        const intent = verifyUpgradeIntentToken({
          token: upgradeIntentToken,
          bookingId: originalBooking?._id || originalOrderId,
          email: normalizedUpgradeEmail,
          targetPackageTitle: packageTitle,
        });
        if (!intent) {
          return res.status(403).json({
            error: "Upgrade authorization expired or no longer matches.",
          });
        }
      }
      const allowedUpgradeEmails = [originalBooking?.email, originalBooking?.payerEmail]
        .map(normalizeEmail)
        .filter(Boolean);

      if (
        !isInternalPaymentFinalization &&
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
      const resolvedCouponDiscountType = String(
        bookingDoc.couponDiscountType || ""
      ).trim();
      const resolvedCouponDiscountValue = Number(
        bookingDoc.couponDiscountValue || 0
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
          couponDiscountType: resolvedCouponDiscountType,
          couponDiscountValue: resolvedCouponDiscountValue,
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
        if (existingRecord.status === PAYMENT_STATUS_REFUNDED) {
          return existingRecord;
        }
        let recordPatch = writeClient.patch(existingRecord._id);
        if (
          existingRecord._rev &&
          typeof recordPatch.ifRevisionId === "function"
        ) {
          recordPatch = recordPatch.ifRevisionId(existingRecord._rev);
        }
        try {
          await recordPatch
            .set(recordSet)
            .setIfMissing({
              _type: PAYMENT_RECORD_TYPE,
              createdAt: existingRecord.createdAt || now,
            })
            .commit();
        } catch (error) {
          if (Number(error?.statusCode || error?.status || 0) !== 409) {
            throw error;
          }
        }
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
        const racedRecord = await writeClient.fetch(
          `*[_type == $type && _id == $id][0]`,
          { type: PAYMENT_RECORD_TYPE, id: recordId }
        );
        if (racedRecord?.status !== PAYMENT_STATUS_REFUNDED) {
          let racedPatch = writeClient.patch(recordId);
          if (racedRecord?._rev && typeof racedPatch.ifRevisionId === "function") {
            racedPatch = racedPatch.ifRevisionId(racedRecord._rev);
          }
          await racedPatch
            .set(recordSet)
            .setIfMissing({
              _type: PAYMENT_RECORD_TYPE,
              createdAt: now,
            })
            .commit()
            .catch((patchError) => {
              if (Number(patchError?.statusCode || patchError?.status || 0) !== 409) {
                throw patchError;
              }
            });
        }
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
          backend: booking.backendOwner || "sanity",
          cutoverGeneration: Number(booking.cutoverGeneration || 0),
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
      if (normalizedStatus !== "captured") {
        return res.status(400).json({
          error: "Free bookings must have status 'captured'.",
        });
      }
    }

    if (paymentProvider === "paypal" || paymentProvider === "razorpay") {
      if (normalizedStatus !== "captured") {
        return res.status(400).json({
          error: "Only captured payments can create bookings.",
        });
      }
    }

    if (normalizedStatus === "captured" && paymentProvider !== "free") {
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
    if (!isExactWholeMinute(normalizedStartTimeUTC)) {
      return res.status(400).json({
        error: "startTimeUTC must be an exact configured minute.",
      });
    }
    const bookingDocId = buildDeterministicBookingId({
      paymentRecordId,
      paymentProvider,
      providerOrderId: paypalOrderId || razorpayOrderId,
      providerPaymentId: razorpayPaymentId,
      idempotencyKey: bookingRequestId,
      originalOrderId,
      startTimeUTC: normalizedStartTimeUTC,
      email: resolvedEmail,
      couponCode,
    });
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

    if (!isUpgrade) {
      const settings = await getBookingSettings({ client: writeClient });
      const slotPolicy = isSlotAllowedForPackage({
        settings,
        packageTitle,
        startTimeUTC: normalizedStartTimeUTC,
      });
      if (!slotPolicy.allowed) {
        return res.status(400).json({
          error: "This time is not available for the selected package.",
        });
      }
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
      normalizedStatus === "captured" &&
      (paymentProvider === "paypal" || paymentProvider === "razorpay");

    if (!isUpgrade) {
      const existingBookings = await writeClient.fetch(
        `*[_type == "booking" && startTimeUTC == $startTimeUTC]{_id,status}`,
        { startTimeUTC: normalizedStartTimeUTC }
      );

      if ((Array.isArray(existingBookings) ? existingBookings : []).some(
        (booking) => isBookingBlockingStatus(booking?.status)
      )) {
        return res.status(409).json({
          error: "This slot is already booked.",
        });
      }

      fetchActiveHold = () =>
        writeClient.fetch(
          `*[_type == "slotHold"
              && hostDate == $date
              && hostTime == $time
              && (!defined(phase) || phase in ["active", "payment_pending"])
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

    const livePricing = isInternalPaymentFinalization
      ? null
      : await resolveBookingPricing({
          packageTitle,
          originalOrderId,
          referralId,
          referralCode,
          couponCode,
          paymentProvider,
          client: writeClient,
          upgradeContext,
        });
    const frozenPricing = internalPaymentRecord?.pricingSnapshot;
    if (
      isInternalPaymentFinalization &&
      (!frozenPricing ||
        !Number.isFinite(Number(frozenPricing.grossAmount)) ||
        !Number.isFinite(Number(frozenPricing.netAmount)))
    ) {
      return res.status(409).json({
        error: "Frozen payment pricing is unavailable.",
      });
    }
    const resolvedPricing = isInternalPaymentFinalization
      ? {
          couponDiscountAmount: Number(frozenPricing.couponDiscountAmount || 0),
          couponDiscountPercent: Number(frozenPricing.couponDiscountPercent || 0),
          couponDiscountType: String(frozenPricing.couponDiscountType || "").trim(),
          couponDiscountValue: Number(frozenPricing.couponDiscountValue || 0),
          couponDoc: null,
          effectiveCommissionPercent: Number(frozenPricing.commissionPercent || 0),
          effectiveDiscountAmount: Number(frozenPricing.discountAmount || 0),
          effectiveDiscountPercent: Number(frozenPricing.discountPercent || 0),
          effectiveGrossAmount: Number(frozenPricing.grossAmount || 0),
          effectiveNetAmount: Number(frozenPricing.netAmount || 0),
          effectiveReferralCode: String(
            frozenPricing.effectiveReferralCode || ""
          ).trim(),
          effectiveReferralId: String(
            frozenPricing.effectiveReferralId || ""
          ).trim(),
          commissionAmount: Number(frozenPricing.commissionAmount || 0),
        }
      : livePricing;
    const {
      couponDiscountAmount,
      couponDiscountPercent,
      couponDiscountType,
      couponDiscountValue,
      couponDoc,
      effectiveCommissionPercent,
      effectiveDiscountAmount,
      effectiveDiscountPercent,
      effectiveGrossAmount,
      effectiveNetAmount,
      effectiveReferralCode,
      effectiveReferralId,
      commissionAmount,
    } = resolvedPricing;
    if (paymentProvider === "free" && effectiveNetAmount > 0) {
      return res.status(400).json({
        error: "The server quote still requires payment.",
      });
    }
    const resolvedPackagePrice = `$${effectiveGrossAmount.toFixed(2)}`;

    let verifiedPayerEmail = payerEmail;

    if (paymentProvider === "razorpay") {
      const canUseServerVerifiedCapture =
        trustedPaymentFinalizeSource &&
        !!paymentRecordId &&
        !!razorpayOrderId &&
        !!razorpayPaymentId;
      if (
        !razorpayOrderId ||
        !razorpayPaymentId ||
        (!razorpaySignature && !canUseServerVerifiedCapture)
      ) {
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
        if (razorpaySignature) {
          const validSignature = verifyRazorpaySignature({
            orderId: razorpayOrderId,
            paymentId: razorpayPaymentId,
            signature: razorpaySignature,
            secret: razorpaySecret,
          });
          if (!validSignature) {
            return res.status(400).json({ error: "Payment verification failed." });
          }
        }

        const paymentVerification = await verifyRazorpayPayment({
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
          expectedAmount: effectiveNetAmount,
          expectedCurrency: DEFAULT_RAZORPAY_CURRENCY,
        });

        if (!paymentVerification.ok) {
          logSafeError("Razorpay verification rejected", {
            name: "PaymentVerificationError",
            code: paymentVerification.reason || "razorpay_verification_rejected",
            status: 400,
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
          logSafeError("PayPal verification rejected", {
            name: "PaymentVerificationError",
            code: paypalVerification.reason || "paypal_verification_rejected",
            status: 400,
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
        backend: holdDoc?.backendOwner === "supabase" ? "supabase" : "sanity",
        cutoverGeneration: Number(holdDoc?.cutoverGeneration || 0),
      });
      const signedExpiredHoldToken = verifyHoldToken({
        token: slotHoldToken,
        holdId: slotHoldId,
        startTimeUTC: holdUtcIso || normalizedStartTimeUTC,
        holdNonce: holdDoc?.holdNonce || "",
        backend: holdDoc?.backendOwner === "supabase" ? "supabase" : "sanity",
        cutoverGeneration: Number(holdDoc?.cutoverGeneration || 0),
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

    let paymentProofClaim = null;
    let paymentRecordForLease = null;
    if (paymentProofClaimId || paymentFinalizationLeaseId) {
      const requiresPaymentProofClaim = true;
      if (
        !paymentRecordId ||
        !paymentFinalizationLeaseId ||
        (requiresPaymentProofClaim && !paymentProofClaimId)
      ) {
        return res.status(409).json({
          error: "Payment finalization authorization is incomplete.",
        });
      }
      [paymentProofClaim, paymentRecordForLease] = await Promise.all([
        preparedPaymentProofClaim?._id === paymentProofClaimId
          ? Promise.resolve(preparedPaymentProofClaim)
          : paymentProofClaimId
          ? writeClient.fetch(
              `*[_type == "paymentProofClaim" && _id == $id][0]{...}`,
              { id: paymentProofClaimId }
            )
          : null,
        Promise.resolve(internalPaymentRecord),
      ]);
      const expectedOrderId = paypalOrderId || razorpayOrderId;
      const leaseExpiresAt = new Date(
        paymentRecordForLease?.finalizationLeaseExpiresAt || ""
      ).getTime();
      const invalidClaim = requiresPaymentProofClaim && (
        !paymentProofClaim?._id ||
        paymentProofClaim.paymentRecordId !== paymentRecordId ||
        paymentProofClaim.provider !== paymentProvider ||
        paymentProofClaim.providerOrderId !== expectedOrderId ||
        (razorpayPaymentId &&
          paymentProofClaim.providerPaymentId !== razorpayPaymentId) ||
        (paymentProofClaim.bookingId && paymentProofClaim.bookingId !== bookingDocId)
      );
      const invalidLease =
        !paymentRecordForLease?._id ||
        paymentRecordForLease.provider !== paymentProvider ||
        paymentRecordForLease.status !== "finalizing" ||
        (requiresPaymentProofClaim &&
          paymentRecordForLease.paymentProofClaimId !== paymentProofClaimId) ||
        paymentRecordForLease.finalizationLeaseId !== paymentFinalizationLeaseId ||
        !Number.isFinite(leaseExpiresAt) ||
        leaseExpiresAt <= Date.now();
      if (invalidClaim || invalidLease) {
        return res.status(409).json({
          error: "Payment finalization authorization is no longer valid.",
        });
      }
    }

    let couponReservation = null;
    if (
      couponCode &&
      normalizedStatus === "captured" &&
      !preserveHistoricalAccounting
    ) {
      if (existingCouponReservationId) {
        const redemption = await writeClient.fetch(
          `*[_type == "couponRedemption" && _id == $id][0]{...}`,
          { id: existingCouponReservationId }
        );
        if (!redemption?._id || redemption.status !== "reserved") {
          return res.status(409).json({
            error: "Coupon reservation is no longer available.",
          });
        }
        const reservedCoupon = await writeClient.fetch(
          `*[_type == "coupon" && _id == $id][0]{...}`,
          { id: redemption.coupon?._ref || couponDoc?._id }
        );
        couponReservation = { coupon: reservedCoupon, redemption, idempotent: true };
      } else {
        couponReservation = await reserveCouponUse({
          client: writeClient,
          couponCode,
          ownerId: paymentRecordId || bookingDocId,
          bookingId: bookingDocId,
          paymentRecordId,
        });
      }
    }

    const bookingDocument = {
      _id: bookingDocId,
      _type: "booking",
      backendOwner,
      cutoverGeneration,
      paymentRecordId,
      paymentProofClaimId,
      paymentFinalizationLeaseId,
      date: bookingDate,
      time: bookingTime,
      discord: resolvedDiscord,
      email: resolvedEmail,
      specs: resolvedSpecs,
      mainGame: resolvedMainGame,
      message: resolvedMessage,
      packageTitle,
      packagePrice: resolvedPackagePrice,
      status: normalizedStatus,
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
      slotReservationState,
      ...(isInternalPaymentFinalization && emailDispatchAlreadyComplete
        ? {
            emailDispatchStatus: "sent",
            emailDispatchDeferred: false,
            emailDispatchClientSentAt:
              emailDispatchCompletedAt || new Date().toISOString(),
            emailDispatchOwnerSentAt:
              emailDispatchCompletedAt || new Date().toISOString(),
          }
        : {}),
      ...(originalOrderId ? { originalOrderId } : {}),
      ...(couponCode
        ? {
            couponCode,
            couponDiscountPercent,
            couponDiscountAmount,
            couponDiscountType,
            couponDiscountValue,
          }
        : {}),
      ...(effectiveReferralId
        ? { referral: { _type: "reference", _ref: effectiveReferralId } }
        : {}),
    };
    const committed = await commitBookingTransaction({
      client: writeClient,
      booking: bookingDocument,
      idempotencyKey: bookingRequestId,
      slot: isUpgrade ? null : { startTimeUTC: normalizedStartTimeUTC },
      hold: holdDoc,
      couponReservation,
      referralId:
        normalizedStatus === "captured" && !preserveHistoricalAccounting
          ? effectiveReferralId || ""
          : "",
      paymentProofClaim,
      paymentRecordMutation: paymentRecordForLease
        ? {
            id: paymentRecordForLease._id,
            revision: paymentRecordForLease._rev,
            set: {
              status: PAYMENT_STATUS_BOOKED,
              finalizationLeaseId: "",
              finalizationLeaseExpiresAt: "",
              recoveryReason: "",
            },
          }
        : null,
      allowMissingHold:
        slotReservationState === "reconciled_after_expired_hold" ||
        slotReservationState === "reconciled_after_missing_hold",
    });

    return respondWithStoredBooking({
      bookingId: committed.bookingId,
      idempotent: committed.idempotent,
    });
  } catch (err) {
    const message = err?.message || "Server error";
    const status = Number(err?.status) || 500;
    logSafeError("Booking creation failed", err);
    return res
      .status(status)
      .json({ error: status < 500 ? message : "Booking could not be completed." });
  }
}
