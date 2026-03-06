import { Resend } from "resend";
import { createClient } from "@sanity/client";
import crypto from "crypto";
import dotenv from "dotenv";
import { verifyHoldToken } from "../../src/server/booking/holdToken.js";
import { resolveBookingPricing } from "./pricing.js";
import { buildSlotBookingId } from "../../src/server/booking/slotIdentity.js";

dotenv.config({ path: ".env.local" });

const writeClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const DISCORD_INVITE_URL = "https://discord.gg/M7nTkn9dxE";
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

  if (status !== "authorized" && status !== "captured") {
    return { ok: false, reason: `razorpay_status_${status || "unknown"}` };
  }

  if (paidAmount !== expectedSubunits) {
    return { ok: false, reason: "razorpay_amount_mismatch" };
  }

  return { ok: true };
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
  if (!clientId || !clientSecret) return null;

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data?.access_token || null;
};

const verifyPayPalOrder = async ({ orderId, expectedAmount }) => {
  const token = await getPayPalToken();
  if (!token) return { ok: false, reason: "paypal_credentials_missing" };

  const response = await fetch(
    `${getPayPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
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

  const paidAmount =
    toMoney(
      details?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ||
        details?.purchase_units?.[0]?.amount?.value ||
        0
    ) || 0;

  if (Math.abs(paidAmount - expectedAmount) > 0.01) {
    return { ok: false, reason: "paypal_amount_mismatch" };
  }

  return {
    ok: true,
    payerEmail: details?.payer?.email_address || "",
  };
};

const emailHtml = ({
  logoUrl,
  siteName,
  heading,
  intro,
  fields,
  discordInviteUrl,
  discordLabel,
}) => `
  <div style="font-family:Inter,Arial,sans-serif;background:#0b1120;padding:24px;color:#e5f2ff">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#0f172a;border:1px solid rgba(56,189,248,.2);border-radius:16px;overflow:hidden">
      <tr>
        <td style="padding:24px;text-align:center;border-bottom:1px solid rgba(56,189,248,.15)">
          <img src="${logoUrl}" alt="${siteName}" style="height:48px;display:block;margin:0 auto 8px"/>
          <div style="font-weight:700;font-size:18px;color:#7dd3fc">${siteName}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:24px">
          <h1 style="margin:0 0 8px;font-size:20px;color:#a5e8ff">${heading}</h1>

          ${
            discordInviteUrl
              ? `
          <p style="margin:0 0 10px;">
            <a
              href="${discordInviteUrl}"
              style="
                display:inline-block;
                padding:8px 14px;
                border-radius:999px;
                background:#38bdf8;
                color:#0b1120;
                font-size:13px;
                text-decoration:none;
                font-weight:600;
              "
            >
              ${discordLabel || "Join the Roo Industries Discord (Required)"}
            </a>
          </p>`
              : ""
          }

          <p style="margin:10px 0 16px;opacity:.85">${intro}</p>
          <table cellpadding="0" cellspacing="0" style="width:100%;background:#0b1120;border:1px solid rgba(56,189,248,.15);border-radius:12px">
            <tbody>
              ${fields
                .map(
                  (f) => `
                <tr>
                  <td style="padding:10px 14px;color:#93c5fd;width:40%">${f.label}</td>
                  <td style="padding:10px 14px;color:#e5f2ff">${f.value}</td>
                </tr>`
                )
                .join("")}
            </tbody>
          </table>
          <p style="margin:18px 0 0;font-size:12px;color:#94a3b8">This is an automatic email from ${siteName}.</p>
        </td>
      </tr>
    </table>
  </div>
`;

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
    } = req.body || {};
    const isUpgrade = !!originalOrderId;

    let originalBooking = null;
    if (isUpgrade) {
      originalBooking = await writeClient.fetch(
        `*[_type == "booking" && _id == $id][0]{
          _id,
          status,
          discord,
          email,
          payerEmail,
          specs,
          mainGame,
          message,
          localTimeZone,
          startTimeUTC,
          displayDate,
          displayTime
        }`,
        { id: originalOrderId }
      );

      if (!originalBooking?._id) {
        return res.status(400).json({
          error: "Original booking could not be verified for this upgrade.",
        });
      }

      const originalStatus = String(originalBooking.status || "").toLowerCase();
      const originalPaid =
        originalStatus === "captured" || originalStatus === "completed";
      if (!originalPaid) {
        return res.status(400).json({
          error: "Only paid bookings can be upgraded.",
        });
      }

      const allowedUpgradeEmails = [
        originalBooking.email,
        originalBooking.payerEmail,
      ]
        .map(normalizeEmail)
        .filter(Boolean);
      const normalizedUpgradeEmail = normalizeEmail(email);

      if (
        normalizedUpgradeEmail &&
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
        return res.status(200).json({
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
        return res.status(200).json({
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

      const now = new Date();
      const fetchActiveHold = () =>
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

      const holdDoc = await writeClient.fetch(
        `*[_type == "slotHold" && _id == $id][0]`,
        { id: slotHoldId }
      );

      if (!holdDoc) {
        return res
          .status(409)
          .json({ error: "Your slot reservation expired." });
      }

      if (holdDoc.expiresAt && new Date(holdDoc.expiresAt) < now) {
        try {
          await writeClient.delete(slotHoldId);
        } catch {}
        return res
          .status(409)
          .json({ error: "Your slot reservation expired." });
      }

      const holdUtc = parseUtcDate(holdDoc.startTimeUTC);
      const holdUtcIso = holdUtc ? holdUtc.toISOString() : "";
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

      const validHoldToken = verifyHoldToken({
        token: slotHoldToken,
        holdId: slotHoldId,
        startTimeUTC: holdUtcIso || normalizedStartTimeUTC,
        holdNonce: holdDoc.holdNonce || "",
      });

      if (!validHoldToken) {
        return res.status(403).json({
          error: "This slot reservation is not valid for your session.",
        });
      }

      const activeHold = await fetchActiveHold();
      if (activeHold && activeHold._id !== slotHoldId) {
        return res.status(409).json({
          error: "This slot is temporarily reserved by another user.",
        });
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
          console.warn(
            `Razorpay verification rejected: ${paymentVerification.reason || "unknown"}`
          );
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
        });
        if (!paypalVerification.ok) {
          console.warn(
            `PayPal verification rejected: ${paypalVerification.reason || "unknown"}`
          );
          return res.status(400).json({
            error: "Payment verification failed.",
          });
        }
        if (paypalVerification.payerEmail) {
          verifiedPayerEmail = paypalVerification.payerEmail;
        }
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
            return res.status(200).json({
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

    let owner = process.env.OWNER_EMAIL;
    try {
      const settings = await writeClient.fetch(
        `*[_type == "bookingSettings"][0]{ ownerEmail }`
      );
      const ownerFromSettings = String(settings?.ownerEmail || "").trim();
      if (ownerFromSettings) {
        owner = ownerFromSettings;
      }
    } catch (ownerErr) {
      console.error(
        "Failed to load booking owner email:",
        ownerErr?.message || ownerErr
      );
    }

    const siteName = process.env.SITE_NAME || "Roo Industries";
    const logoUrl =
      process.env.LOGO_URL || "https://rooindustries.com/embed_logo.png";
    const from = process.env.FROM_EMAIL;

    const formatMoney = (value) =>
      Number.isFinite(value) ? value.toFixed(2) : "0.00";
    const discountPercentValue =
      typeof effectiveDiscountPercent === "number" ? effectiveDiscountPercent : 0;
    const discountAmountValue =
      typeof effectiveDiscountAmount === "number" ? effectiveDiscountAmount : 0;
    const couponPercentValue =
      typeof couponDiscountPercent === "number" ? couponDiscountPercent : 0;
    const couponAmountValue =
      typeof couponDiscountAmount === "number" ? couponDiscountAmount : 0;
    const couponSuffix =
      couponPercentValue > 0 || couponAmountValue > 0
        ? ` (${couponPercentValue}% - $${formatMoney(couponAmountValue)})`
        : "";
    const couponDisplay = couponCode ? `${couponCode}${couponSuffix}` : "-";
    const referralDisplay = effectiveReferralCode || "-";

    const sharedCoreFields = [
      { label: "Package", value: `${packageTitle || "-"}` },
      {
        label: "Price",
        value:
          effectiveNetAmount < effectiveGrossAmount
            ? `$${formatMoney(effectiveNetAmount)} (was $${formatMoney(effectiveGrossAmount)})`
            : resolvedPackagePrice,
      },
      { label: "Discord", value: discord || "-" },
      { label: "Email", value: email || "-" },
      { label: "Main Game", value: mainGame || "-" },
      { label: "PC Specs", value: specs || "-" },
      { label: "Notes", value: message || "-" },
      { label: "Referral Code", value: referralDisplay },
      { label: "Coupon Code", value: couponDisplay },
      { label: "Order ID", value: doc._id },
    ];

    const ownerDiscountFields = [];

    if (discountPercentValue > 0 || discountAmountValue > 0) {
      ownerDiscountFields.push({
        label: "Discount",
        value: `${discountPercentValue}% ($${formatMoney(discountAmountValue)})`,
      });
    }

    const clientFields = [
      { label: "Date", value: clientDate || "-" },
      { label: "Time", value: clientTime || "-" },
      ...(clientTimeZone ? [{ label: "Time Zone", value: clientTimeZone }] : []),
      ...sharedCoreFields,
    ];

    const ownerFields = [
      { label: "Client Date", value: clientDate || "-" },
      { label: "Client Time", value: clientTime || "-" },
      ...(clientTimeZone ? [{ label: "Client Time Zone", value: clientTimeZone }] : []),
      { label: "Date", value: ownerDate || "-" },
      { label: "Time", value: ownerTime || "-" },
      { label: "Time Zone", value: OWNER_TZ_NAME },
      ...ownerDiscountFields,
      ...sharedCoreFields,
    ];

    const bookingRef = (doc._id || "").slice(-6).toUpperCase() || "BOOKING";

    const clientSubject = `Your ${siteName} booking`;
    const ownerSubject = `New booking ${bookingRef} - ${packageTitle} (${ownerDate} ${ownerTime})`;

    if (from && email && process.env.RESEND_API_KEY) {
      try {
        const { error } = await resend.emails.send({
          from,
          to: email,
          subject: clientSubject,
          html: emailHtml({
            logoUrl,
            siteName,
            heading: "Booking Received ✨",
            intro:
              "To continue with your booking, please join the Roo Industries Discord using the button above. I'll contact you there (or by email if needed) to confirm your time and details.",
            fields: clientFields,
            discordInviteUrl: DISCORD_INVITE_URL,
          }),
        });

        if (error) {
          console.error("Resend client email error:", error);
        }
      } catch (emailErr) {
        console.error("Resend client email exception:", emailErr);
      }
    }

    if (from && owner && process.env.RESEND_API_KEY) {
      try {
        const { error } = await resend.emails.send({
          from,
          to: owner,
          subject: ownerSubject,
          html: emailHtml({
            logoUrl,
            siteName,
            heading: "New Booking Received",
            intro: "A new booking was submitted:",
            fields: ownerFields,
          }),
        });
        if (error) {
          console.error("Resend owner email error:", error);
        }
      } catch (emailErr) {
        console.error("Resend owner email exception:", emailErr);
      }
    }

    return res.status(200).json({ bookingId: doc._id });
  } catch (err) {
    const message = err?.message || "Server error";
    const code = err?.code;
    const status = Number(err?.status) || 500;
    console.error("Booking API error:", { message, code });
    return res.status(status).json({ error: message });
  }
}
