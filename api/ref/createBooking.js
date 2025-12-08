// api/createBooking.js
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

const emailHtml = ({ logoUrl, siteName, heading, intro, fields }) => `
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
          <p style="margin:0 0 16px;opacity:.85">${intro}</p>
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
      // booking fields
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

      // upgrades
      originalOrderId = "",

      // coupon fields
      couponCode = "",
      couponDiscountPercent = 0,
      couponDiscountAmount = 0,

      // time metadata
      hostDate,
      hostTime,
      hostTimeZone,
      localTimeZone,
      localTimeLabel,
      startTimeUTC,
      displayDate,
      displayTime,

      // NEW: slot hold
      slotHoldId = "",
      slotHoldExpiresAt = "",
    } = req.body || {};

    let effectiveReferralId = referralId || null;
    let effectiveReferralCode = referralCode || "";
    let effectiveDiscountPercent = discountPercent || 0;
    let effectiveDiscountAmount = discountAmount || 0;
    let effectiveGrossAmount = grossAmount || 0;
    let effectiveNetAmount = netAmount || 0;
    let effectiveCommissionPercent = commissionPercent || 0;

    // normalize booking date/time
    const bookingDate = hostDate || date || displayDate || "";
    const bookingTime = hostTime || time || displayTime || "";

    if (!bookingDate || !bookingTime) {
      return res.status(400).json({
        error: "Missing booking date/time (hostDate/hostTime/display fields).",
      });
    }

    // ===== SLOT COLLISION & HOLDS =====

    // 1) already booked?
    const existingBooking = await writeClient.fetch(
      `*[_type == "booking" && hostDate == $date && hostTime == $time][0]`,
      { date: bookingDate, time: bookingTime }
    );

    if (existingBooking) {
      return res.status(409).json({
        error: "This slot is already booked. Please choose another time.",
      });
    }

    let holdDoc = null;

    if (slotHoldId) {
      // 2a) hold must exist & be active
      holdDoc = await writeClient.fetch(
        `*[_type == "slotHold" && _id == $id][0]`,
        { id: slotHoldId }
      );

      if (!holdDoc) {
        return res
          .status(409)
          .json({ error: "Your slot reservation has expired. Please rebook." });
      }

      if (holdDoc.expiresAt && new Date(holdDoc.expiresAt) < new Date()) {
        try {
          await writeClient.delete(slotHoldId);
        } catch (e) {
          console.error("Error deleting expired slotHold:", e);
        }
        return res
          .status(409)
          .json({ error: "Your slot reservation has expired. Please rebook." });
      }

      if (
        holdDoc.hostDate !== bookingDate ||
        holdDoc.hostTime !== bookingTime
      ) {
        return res.status(400).json({
          error: "Slot hold does not match the selected time. Please rebook.",
        });
      }
    } else {
      // 2b) if no holdId, still respect active holds
      const activeHold = await writeClient.fetch(
        `*[_type == "slotHold" 
            && hostDate == $date 
            && hostTime == $time 
            && expiresAt > now()
          ][0]`,
        { date: bookingDate, time: bookingTime }
      );

      if (activeHold) {
        return res.status(409).json({
          error:
            "This time is temporarily reserved by another user. Please refresh and choose another slot.",
        });
      }
    }

    // ===== TIME VARIANTS =====
    const localDate = displayDate || date || hostDate || "—";
    const localTime = displayTime || localTimeLabel || time || "—";

    const istDate = hostDate || date || displayDate || "—";
    const istTime = hostTime || time || displayTime || "—";

    // ===== MONEY / REFERRAL =====
    if (!effectiveGrossAmount) {
      const numericPrice =
        parseFloat(String(packagePrice || "").replace(/[^0-9.]/g, "")) || 0;
      effectiveGrossAmount = numericPrice;
    }

    if (effectiveReferralCode) {
      try {
        const refDoc = await writeClient.fetch(
          `*[_type == "referral" && slug.current == $code][0]{
            _id,
            currentDiscountPercent,
            currentCommissionPercent,
            maxCommissionPercent,
            bypassUnlock,
            successfulReferrals
          }`,
          { code: effectiveReferralCode }
        );

        if (refDoc) {
          if (!effectiveReferralId) {
            effectiveReferralId = refDoc._id;
          }

          const successfulReferrals = refDoc.successfulReferrals ?? 0;
          const unlocked =
            successfulReferrals >= 5 || refDoc.bypassUnlock === true;

          const defaultCommission = 10;
          const defaultDiscount = 0;

          const refCommission = unlocked
            ? refDoc.currentCommissionPercent ?? defaultCommission
            : defaultCommission;

          const refDiscount = unlocked
            ? refDoc.currentDiscountPercent ?? defaultDiscount
            : defaultDiscount;

          if (!effectiveCommissionPercent) {
            effectiveCommissionPercent = refCommission;
          }

          if (!effectiveDiscountPercent) {
            effectiveDiscountPercent = refDiscount;
          }
        }
      } catch (lookupErr) {
        console.error("❌ Error fetching referral for booking:", lookupErr);
      }
    }

    if (!effectiveDiscountAmount && effectiveDiscountPercent) {
      effectiveDiscountAmount = +(
        effectiveGrossAmount *
        (effectiveDiscountPercent / 100)
      ).toFixed(2);
    }

    if (!effectiveNetAmount) {
      effectiveNetAmount = +(
        effectiveGrossAmount - (effectiveDiscountAmount || 0)
      ).toFixed(2);
    }

    const commissionBase = effectiveNetAmount || effectiveGrossAmount || 0;

    const commissionAmount = +(
      commissionBase *
      ((effectiveCommissionPercent || 0) / 100)
    ).toFixed(2);

    // ===== CREATE BOOKING DOC =====
    const doc = await writeClient.create({
      _type: "booking",
      date: bookingDate,
      time: bookingTime,

      hostDate,
      hostTime,
      hostTimeZone,
      localTimeZone,
      localTimeLabel,
      startTimeUTC,
      displayDate,
      displayTime,

      discord,
      email,
      specs,
      mainGame,
      message,
      packageTitle,
      packagePrice,
      status,

      referralCode: effectiveReferralCode,
      discountPercent: effectiveDiscountPercent,
      discountAmount: effectiveDiscountAmount,
      grossAmount: effectiveGrossAmount,
      netAmount: effectiveNetAmount,
      commissionPercent: effectiveCommissionPercent,
      commissionAmount,
      paypalOrderId,
      payerEmail,

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

    // delete hold after success
    if (slotHoldId) {
      try {
        await writeClient.delete(slotHoldId);
      } catch (e) {
        console.error("Error deleting slotHold after booking:", e);
      }
    }

    // ===== REFERRAL SUCCESS COUNTER =====
    if (effectiveReferralId && status === "captured") {
      const updated = await writeClient
        .patch(effectiveReferralId)
        .inc({ successfulReferrals: 1 })
        .commit();

      if (updated.successfulReferrals >= 5 && updated.isFirstTime) {
        await writeClient
          .patch(effectiveReferralId)
          .set({
            isFirstTime: false,
            currentDiscountPercent: updated.currentDiscountPercent || 0,
          })
          .commit();
      }
    }

    // ===== EMAILS =====
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
          (effectiveDiscountPercent || effectiveDiscountAmount) &&
          typeof effectiveNetAmount === "number" &&
          !Number.isNaN(effectiveNetAmount)
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

    const clientMoneyAndReferral = [
      ...(effectiveReferralCode
        ? [{ label: "Referral Code", value: effectiveReferralCode }]
        : []),
      ...(effectiveDiscountPercent || effectiveDiscountAmount
        ? [
            {
              label: "Total Discount",
              value: `${effectiveDiscountPercent}% (-$${effectiveDiscountAmount.toFixed(
                2
              )})`,
            },
          ]
        : []),
      ...(couponCode
        ? [
            {
              label: "Coupon Code",
              value: couponCode,
            },
          ]
        : []),
      ...(couponCode && (couponDiscountPercent || couponDiscountAmount)
        ? [
            {
              label: "Coupon Discount",
              value: `${couponDiscountPercent}% (-$${couponDiscountAmount.toFixed(
                2
              )})`,
            },
          ]
        : []),
      ...(originalOrderId
        ? [
            {
              label: "Upgrade From Order",
              value: originalOrderId,
            },
          ]
        : []),
      {
        label: "Order ID",
        value: doc._id || "—",
      },
    ];

    const clientFields = [
      {
        label: "Discord Server",
        value:
          '<a href="https://discord.gg/M7nTkn9dxE" style="color:#7dd3fc;text-decoration:underline">Join the Roo Industries Discord</a>',
      },
      { label: "Date", value: localDate },
      {
        label: "Your Time",
        value:
          localTime && localTime !== "—"
            ? localTimeZone
              ? `${localTime} (${localTimeZone})`
              : localTime
            : "—",
      },
      {
        label: "Host Time",
        value:
          istTime && istTime !== "—"
            ? hostTimeZone
              ? `${istTime} (${hostTimeZone})`
              : `${istTime} (host)`
            : "—",
      },
      ...sharedCoreFields,
      ...clientMoneyAndReferral,
    ];

    const ownerMoneyAndReferral = [
      ...(effectiveReferralCode
        ? [{ label: "Referral Code", value: effectiveReferralCode }]
        : []),
      ...(effectiveDiscountPercent || effectiveDiscountAmount
        ? [
            {
              label: "Total Discount",
              value: `${effectiveDiscountPercent}% (-$${effectiveDiscountAmount.toFixed(
                2
              )})`,
            },
          ]
        : []),
      ...(couponCode
        ? [
            {
              label: "Coupon Code",
              value: couponCode,
            },
          ]
        : []),
      ...(couponCode && (couponDiscountPercent || couponDiscountAmount)
        ? [
            {
              label: "Coupon Discount",
              value: `${couponDiscountPercent}% (-$${couponDiscountAmount.toFixed(
                2
              )})`,
            },
          ]
        : []),
      ...(typeof effectiveGrossAmount === "number" &&
      !Number.isNaN(effectiveGrossAmount)
        ? [
            {
              label: "Gross Amount",
              value: `$${effectiveGrossAmount.toFixed(2)}`,
            },
          ]
        : []),
      ...(typeof effectiveNetAmount === "number" &&
      !Number.isNaN(effectiveNetAmount)
        ? [
            {
              label: "Net Amount",
              value: `$${effectiveNetAmount.toFixed(2)}`,
            },
          ]
        : []),
      ...(effectiveCommissionPercent || commissionAmount
        ? [
            {
              label: "Commission",
              value: `${effectiveCommissionPercent}% ($${commissionAmount.toFixed(
                2
              )})`,
            },
          ]
        : []),
      ...(originalOrderId
        ? [
            {
              label: "Upgrade From Order",
              value: originalOrderId,
            },
          ]
        : []),
      {
        label: "Order ID",
        value: doc._id || "—",
      },
    ];

    const ownerFields = [
      { label: "Date", value: istDate },
      {
        label: "Time / Timezones",
        value:
          istTime && localTime && istTime !== "—" && localTime !== "—"
            ? `${istTime} (${hostTimeZone || "host"}) — ${localTime} (${
                localTimeZone || "client"
              })`
            : istTime || localTime || "—",
      },
      ...sharedCoreFields,
      ...ownerMoneyAndReferral,
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
          }),
        });
      } catch (err) {
        console.error("❌ Error sending customer email:", err);
      }
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
      } catch (err) {
        console.error("❌ Error sending owner email:", err);
      }
    }

    return res.status(200).json({ bookingId: doc._id });
  } catch (err) {
    console.error("❌ Booking API error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
