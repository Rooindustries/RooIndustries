import { Resend } from "resend";
import { createClient } from "@sanity/client";

const writeClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const resend = new Resend(process.env.RESEND_API_KEY);

// Discord invite (your link)
const DISCORD_INVITE_URL = "https://discord.gg/M7nTkn9dxE";

const emailHtml = ({
  logoUrl,
  siteName,
  heading,
  intro,
  fields,
  discordInviteUrl,
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
              Join the Roo Industries Discord
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
      date,
      time,
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

      hostDate,
      hostTime,
      hostTimeZone,
      localTimeZone,
      localTimeLabel,
      startTimeUTC,
      displayDate,
      displayTime,

      slotHoldId = "",
      slotHoldExpiresAt = "",

      paymentProvider = "",
    } = req.body || {};

    // ================================================================
    // 1. Basic paymentProvider validation
    // ================================================================
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

    // ================================================================
    // 2. Special handling for FREE bookings
    //    -> must be backed by a valid, active 100% coupon
    // ================================================================
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

    // ================================================================
    // 3. Paid bookings: require proof for captured status
    // ================================================================
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

    // ================================================================
    // 4. Normalize booking date/time
    // ================================================================
    const bookingDate = hostDate || date || displayDate || "";
    const bookingTime = hostTime || time || displayTime || "";

    if (!bookingDate || !bookingTime) {
      return res.status(400).json({
        error: "Missing booking date/time.",
      });
    }

    // ================================================================
    // 5. Prevent double booking
    // ================================================================
    const existingBooking = await writeClient.fetch(
      `*[_type == "booking" && hostDate == $date && hostTime == $time][0]`,
      { date: bookingDate, time: bookingTime }
    );

    if (existingBooking) {
      return res.status(409).json({
        error: "This slot is already booked.",
      });
    }

    // ================================================================
    // 6. Slot-hold handling
    // ================================================================
    let holdDoc = null;

    if (slotHoldId) {
      holdDoc = await writeClient.fetch(
        `*[_type == "slotHold" && _id == $id][0]`,
        { id: slotHoldId }
      );

      if (!holdDoc) {
        return res
          .status(409)
          .json({ error: "Your slot reservation expired." });
      }

      if (holdDoc.expiresAt && new Date(holdDoc.expiresAt) < new Date()) {
        try {
          await writeClient.delete(slotHoldId);
        } catch {}
        return res
          .status(409)
          .json({ error: "Your slot reservation expired." });
      }

      if (
        holdDoc.hostDate !== bookingDate ||
        holdDoc.hostTime !== bookingTime
      ) {
        return res.status(400).json({
          error: "Slot hold does not match selected time.",
        });
      }
    } else {
      const activeHold = await writeClient.fetch(
        `*[_type == "slotHold"
            && hostDate == $date
            && hostTime == $time
            && expiresAt > now()][0]`,
        { date: bookingDate, time: bookingTime }
      );

      if (activeHold) {
        return res.status(409).json({
          error: "This slot is temporarily reserved by another user.",
        });
      }
    }

    // ================================================================
    // 7. Money calculations
    // ================================================================
    let effectiveReferralId = referralId || null;
    let effectiveReferralCode = referralCode || "";
    let effectiveDiscountPercent = discountPercent || 0;
    let effectiveDiscountAmount = discountAmount || 0;
    let effectiveGrossAmount = grossAmount || 0;
    let effectiveNetAmount = netAmount || 0;
    let effectiveCommissionPercent = commissionPercent || 0;

    // Derive gross if not passed
    if (!effectiveGrossAmount) {
      const numericPrice =
        parseFloat(String(packagePrice || "").replace(/[^0-9.]/g, "")) || 0;
      effectiveGrossAmount = numericPrice;
    }

    // For FREE bookings, enforce 100% discount server-side
    if (paymentProvider === "free") {
      effectiveDiscountPercent = 100;
      effectiveDiscountAmount = effectiveGrossAmount;
      effectiveNetAmount = 0;
    } else {
      // For paid bookings, if net not provided, derive it once
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

    // ================================================================
    // 8. CREATE BOOKING DOCUMENT
    // ================================================================
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

      hostDate,
      hostTime,
      hostTimeZone,
      localTimeZone,
      localTimeLabel,
      startTimeUTC,
      displayDate,
      displayTime,

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

    if (slotHoldId) {
      try {
        await writeClient.delete(slotHoldId);
      } catch {}
    }

    // ================================================================
    // 9. Increment referrals/coupon usage
    // ================================================================
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

    // ================================================================
    // 10. Emails
    // ================================================================
    const siteName = process.env.SITE_NAME || "Roo Industries";
    const logoUrl =
      process.env.LOGO_URL || "https://rooindustries.com/embed_logo.png";
    const from = process.env.FROM_EMAIL;
    const owner = process.env.OWNER_EMAIL;

    const sharedCoreFields = [
      { label: "Package", value: `${packageTitle || "—"}` },
      {
        label: "Price",
        value:
          effectiveNetAmount < effectiveGrossAmount
            ? `$${effectiveNetAmount.toFixed(
                2
              )} (was $${effectiveGrossAmount.toFixed(2)})`
            : `${packagePrice || "—"}`,
      },
      { label: "Discord", value: discord || "—" },
      { label: "Email", value: email || "—" },
      { label: "Main Game", value: mainGame || "—" },
      { label: "PC Specs", value: specs || "—" },
      { label: "Notes", value: message || "—" },
    ];

    const localDate = displayDate || date || hostDate || "—";
    const localTime = displayTime || localTimeLabel || time || "—";

    const istDate = hostDate || date || displayDate || "—";
    const istTime = hostTime || time || displayTime || "—";

    const clientFields = [
      { label: "Date", value: localDate },
      { label: "Your Time", value: localTime },
      { label: "Host Time", value: istTime },
      ...sharedCoreFields,
    ];

    const ownerFields = [
      { label: "Date", value: istDate },
      {
        label: "Time / Timezones",
        value: `${istTime} (${hostTimeZone}) — ${localTime} (${localTimeZone})`,
      },
      ...sharedCoreFields,
      {
        label: "Order ID",
        value: doc._id,
      },
    ];

    if (from && email && process.env.RESEND_API_KEY) {
      try {
        await resend.emails.send({
          from,
          to: email,
          subject: `Your ${siteName} booking request`,
          html: emailHtml({
            logoUrl,
            siteName,
            heading: "Booking Received ✨",
            intro:
              "Thanks for booking! I’ll reach out on Discord/Email to confirm your time.",
            fields: clientFields,
            // 👇 this shows the Discord button at the top
            discordInviteUrl: DISCORD_INVITE_URL,
          }),
        });
      } catch {}
    }

    if (from && owner && process.env.RESEND_API_KEY) {
      try {
        await resend.emails.send({
          from,
          to: owner,
          subject: `New booking — ${packageTitle} (${istDate} ${istTime})`,
          html: emailHtml({
            logoUrl,
            siteName,
            heading: "New Booking Received",
            intro: "A new booking was submitted:",
            fields: ownerFields,
          }),
        });
      } catch {}
    }

    return res.status(200).json({ bookingId: doc._id });
  } catch (err) {
    console.error("❌ Booking API error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
