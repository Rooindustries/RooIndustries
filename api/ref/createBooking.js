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
    } = req.body || {};

    const commissionAmount = +(
      (netAmount || grossAmount || 0) *
      ((commissionPercent || 0) / 100)
    ).toFixed(2);

    // CREATE BOOKING DOCUMENT
    const doc = await writeClient.create({
      _type: "booking",
      date,
      time,
      discord,
      email,
      specs,
      mainGame,
      message,
      packageTitle,
      packagePrice,
      status,

      referralCode,
      discountPercent,
      discountAmount,
      grossAmount,
      netAmount,
      commissionPercent,
      commissionAmount,
      paypalOrderId,
      payerEmail,
      ...(referralId
        ? { referral: { _type: "reference", _ref: referralId } }
        : {}),
    });

    // REFERRAL LOGIC
    if (referralId && status === "captured") {
      try {
        const updated = await writeClient
          .patch(referralId)
          .setIfMissing({
            successfulReferrals: 0,
            isFirstTime: true,
          })
          .inc({ successfulReferrals: 1 })
          .commit();

        const successful = updated.successfulReferrals || 0;

        if (successful >= 5 && updated.isFirstTime) {
          await writeClient
            .patch(referralId)
            .set({
              isFirstTime: false,
              currentDiscountPercent: updated.currentDiscountPercent || 0,
            })
            .commit();
        }
      } catch (err) {
        console.error("❌ Referral update error:", err);
        // Don't throw – booking is already saved
      }
    }

    // ------------------------------------------------------------------

    const siteName = process.env.SITE_NAME || "Roo Industries";
    const logoUrl =
      process.env.LOGO_URL || "https://rooindustries.com/embed_logo.png";
    const from = process.env.FROM_EMAIL;
    const owner = process.env.OWNER_EMAIL;
    const discordLink =
      process.env.DISCORD_LINK || "https://discord.gg/M7nTkn9dxE";

    const shortId = (doc && doc._id && String(doc._id).slice(-6)) || "";

    // Full fields
    const baseFields = [
      { label: "Order ID", value: doc._id || "—" },
      { label: "Package", value: `${packageTitle || "—"}` },
      { label: "Price", value: `${packagePrice || "—"}` },
      { label: "Date", value: date || "—" },
      { label: "Time", value: time || "—" },
      { label: "Discord", value: discord || "—" },
      { label: "Email", value: email || "—" },
      { label: "Main Game", value: mainGame || "—" },
      { label: "PC Specs", value: specs || "—" },
      { label: "Notes", value: message || "—" },
      ...(referralCode
        ? [
            { label: "Referral Code", value: referralCode },
            {
              label: "Discount",
              value: `${discountPercent}% (−$${discountAmount.toFixed?.(2)})`,
            },
            {
              label: "Commission",
              value: `${commissionPercent}% ($${commissionAmount.toFixed?.(
                2
              )})`,
            },
          ]
        : []),
      ...(paypalOrderId
        ? [{ label: "PayPal Order", value: paypalOrderId }]
        : []),
      { label: "Discord Server", value: discordLink },
    ];

    // Client fields
    const customerFields = baseFields.filter(
      (f) => !["Discount", "Commission", "PayPal Order"].includes(f.label)
    );

    // SEND EMAIL TO CLIENT
    if (from && email && process.env.RESEND_API_KEY) {
      try {
        await resend.emails.send({
          from,
          to: email,
          subject: `Your ${siteName} booking${
            shortId ? ` (ID: ${shortId})` : ""
          }`,
          html: emailHtml({
            logoUrl,
            siteName,
            heading: "Booking Received ✨",
            intro: `Thanks for booking! I’ll reach out on Discord/email to confirm your time.\n\nYour order ID is ${doc._id}.\nJoin the Discord here: ${discordLink}`,
            fields: customerFields,
          }),
        });
      } catch (err) {
        console.error("❌ Error sending customer email:", err);
      }
    }

    // SEND EMAIL TO OWNER (FULL INFO)
    if (from && owner && process.env.RESEND_API_KEY) {
      try {
        await resend.emails.send({
          from,
          to: owner,
          subject: `New booking — ${packageTitle} (${date} ${time})`,
          html: emailHtml({
            logoUrl,
            siteName,
            heading: "New Booking Received",
            intro: "A new booking was submitted:",
            fields: baseFields,
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
