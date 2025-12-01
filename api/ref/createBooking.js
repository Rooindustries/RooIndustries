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

      // time metadata
      hostDate,
      hostTime,
      hostTimeZone,
      localTimeZone,
      localTimeLabel,
      startTimeUTC,
      displayDate,
      displayTime,
    } = req.body || {};

    // 🔵 Make everything mutable so we can override / fill it server-side
    let effectiveReferralId = referralId || null;
    let effectiveReferralCode = referralCode || "";
    let effectiveDiscountPercent = discountPercent || 0;
    let effectiveDiscountAmount = discountAmount || 0;
    let effectiveGrossAmount = grossAmount || 0;
    let effectiveNetAmount = netAmount || 0;
    let effectiveCommissionPercent = commissionPercent || 0;

    // Normalize booking date/time to the host view so availability can be marked as booked
    const bookingDate = hostDate || date || displayDate || "";
    const bookingTime = hostTime || time || displayTime || "";

    // ---------- Derived date/time variants ----------
    // What we treat as "local" (user) view:
    const localDate = displayDate || date || hostDate || "—";
    const localTime = displayTime || localTimeLabel || time || "—";

    // What we treat as IST (host) view:
    const istDate = hostDate || date || displayDate || "—";
    const istTime = hostTime || time || displayTime || "—";

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

          // same unlock logic you use on the dashboard:
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

          // derive base price from packagePrice if grossAmount wasn't provided
          if (!effectiveGrossAmount) {
            const numericPrice =
              parseFloat(String(packagePrice || "").replace(/[^0-9.]/g, "")) ||
              0;
            effectiveGrossAmount = numericPrice;
          }

          // derive discount/net amounts if missing
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
        }
      } catch (lookupErr) {
        console.error("❌ Error fetching referral for booking:", lookupErr);
      }
    }

    const commissionBase = effectiveNetAmount || effectiveGrossAmount || 0;

    const commissionAmount = +(
      commissionBase *
      ((effectiveCommissionPercent || 0) / 100)
    ).toFixed(2);

    // CREATE BOOKING DOCUMENT
    const doc = await writeClient.create({
      _type: "booking",
      // original for backwards compatibility
      date: bookingDate,
      time: bookingTime,

      // richer time data
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
      ...(effectiveReferralId
        ? { referral: { _type: "reference", _ref: effectiveReferralId } }
        : {}),
    });

    // REFERRAL LOGIC (only increment on real captured payments)
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

    // ------------------------------------------------------------------

    const siteName = process.env.SITE_NAME || "Roo Industries";
    const logoUrl =
      process.env.LOGO_URL || "https://rooindustries.com/embed_logo.png";
    const from = process.env.FROM_EMAIL;
    const owner = process.env.OWNER_EMAIL;

    // Shared non-money, non-referral fields
    const sharedCoreFields = [
      { label: "Package", value: `${packageTitle || "—"}` },
      { label: "Price", value: `${packagePrice || "—"}` },
      { label: "Discord", value: discord || "—" },
      { label: "Email", value: email || "—" },
      { label: "Main Game", value: mainGame || "—" },
      { label: "PC Specs", value: specs || "—" },
      { label: "Notes", value: message || "—" },
    ];

    // CLIENT EMAIL FIELDS
    const clientMoneyAndReferral = [
      ...(effectiveReferralCode
        ? [{ label: "Referral Code", value: effectiveReferralCode }]
        : []),
      ...(effectiveDiscountPercent || effectiveDiscountAmount
        ? [
            {
              label: "Discount",
              value: `${effectiveDiscountPercent}% (-$${effectiveDiscountAmount.toFixed(
                2
              )})`,
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

    // OWNER EMAIL FIELDS
    const ownerMoneyAndReferral = [
      ...(effectiveReferralCode
        ? [{ label: "Referral Code", value: effectiveReferralCode }]
        : []),
      ...(effectiveDiscountPercent || effectiveDiscountAmount
        ? [
            {
              label: "Discount",
              value: `${effectiveDiscountPercent}% (-$${effectiveDiscountAmount.toFixed(
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

    // SEND EMAILS
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
