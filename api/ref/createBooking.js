import { Resend } from "resend";
import { createClient } from "@sanity/client";
import dotenv from "dotenv";

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
      discountPercent = 0,
      discountAmount = 0,
      grossAmount = 0,
      netAmount = 0,
      commissionPercent = 0,
      paypalOrderId = "",
      payerEmail = "",
      razorpayOrderId = "",
      razorpayPaymentId = "",
      originalOrderId = "",
      couponCode = "",
      couponDiscountPercent = 0,
      couponDiscountAmount = 0,
      localTimeZone,
      startTimeUTC,
      displayDate,
      displayTime,
      slotHoldId = "",
      slotHoldExpiresAt = "",
      paymentProvider = "",
    } = req.body || {};
    const isUpgrade = !!originalOrderId;

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

    const isPaidBooking = status === "captured" && paymentProvider !== "free";

    const utcDate = parseUtcDate(startTimeUTC);
    if (!utcDate) {
      return res.status(400).json({
        error: "Missing or invalid startTimeUTC.",
      });
    }

    const normalizedStartTimeUTC = utcDate.toISOString();
    const ownerDate = formatOwnerDateLabel(utcDate);
    const ownerTime = formatOwnerTimeLabel(utcDate);

    if (!ownerDate || !ownerTime) {
      return res.status(400).json({
        error: "Missing booking date/time.",
      });
    }

    const clientTimeZone = String(localTimeZone || "").trim();
    const clientDate =
      displayDate ||
      (clientTimeZone ? formatClientDateLabel(utcDate, clientTimeZone) : "");
    const clientTime =
      displayTime ||
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

      if (!slotHoldId) {
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

      const activeHold = await fetchActiveHold();
      if (activeHold && activeHold._id !== slotHoldId) {
        return res.status(409).json({
          error: "This slot is temporarily reserved by another user.",
        });
      }
    }

    let effectiveReferralId = referralId || null;
    let effectiveReferralCode = referralCode || "";
    let effectiveDiscountPercent = discountPercent || 0;
    let effectiveDiscountAmount = discountAmount || 0;
    let effectiveGrossAmount = grossAmount || 0;
    let effectiveNetAmount = netAmount || 0;
    let effectiveCommissionPercent = commissionPercent || 0;

    if (!effectiveGrossAmount) {
      const numericPrice =
        parseFloat(String(packagePrice || "").replace(/[^0-9.]/g, "")) || 0;
      effectiveGrossAmount = numericPrice;
    }

    if (paymentProvider === "free") {
      effectiveDiscountPercent = 100;
      effectiveDiscountAmount = effectiveGrossAmount;
      effectiveNetAmount = 0;
    } else {
      if (!effectiveNetAmount) {
        effectiveNetAmount = +(
          effectiveGrossAmount - (effectiveDiscountAmount || 0)
        ).toFixed(2);
      }
    }

    const commissionBase = effectiveNetAmount || effectiveGrossAmount || 0;

    const commissionAmount = +(
      commissionBase *
      ((effectiveCommissionPercent || 0) / 100)
    ).toFixed(2);

    const doc = await writeClient.create({
      _type: "booking",
      date: bookingDate,
      time: bookingTime,
      discord,
      email,
      specs,
      mainGame,
      message,
      packageTitle,
      packagePrice,
      status,
      paymentProvider,
      paypalOrderId,
      payerEmail,
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

    try {
      await writeClient
        .patch(doc._id)
        .setIfMissing({ orderId: doc._id })
        .commit();
    } catch (err) {
      console.error("Failed to set booking orderId:", err);
    }

    if (!isUpgrade) {
      try {
        const holdIds = await writeClient.fetch(
          `*[_type == "slotHold" && hostDate == $date && hostTime == $time]._id`,
          { date: bookingDate, time: bookingTime }
        );

        if (Array.isArray(holdIds) && holdIds.length > 0) {
          await Promise.all(
            holdIds.map((id) => writeClient.delete(id).catch(() => {}))
          );
        }
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
            : `${packagePrice || "-"}`,
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
    console.error("Booking API error:", { message, code });
    return res.status(500).json({ error: message });
  }
}
