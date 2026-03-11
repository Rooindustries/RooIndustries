import { createClient } from "@sanity/client";
import { Resend } from "resend";

const writeClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const resend = new Resend(process.env.RESEND_API_KEY);

export const DISCORD_INVITE_URL = "https://discord.gg/M7nTkn9dxE";
export const OWNER_TZ_NAME = "Asia/Kolkata";
const DEFAULT_LOGO_URL = "https://www.rooindustries.com/embed_logo.png";

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);

const emailHtml = ({
  logoUrl,
  siteName,
  heading,
  intro,
  fields,
  discordInviteUrl = "",
  discordLabel = "",
}) => `
  <div style="margin:0;padding:0;background:#020617;color:#e2e8f0;font-family:Arial,sans-serif">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#020617;padding:24px 0">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#0f172a;border:1px solid rgba(56,189,248,.18);border-radius:18px;padding:28px">
            <tr>
              <td style="text-align:center;padding-bottom:20px">
                <img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(siteName)}" style="height:48px;display:block;margin:0 auto 8px"/>
                <div style="font-weight:700;font-size:18px;color:#7dd3fc">${escapeHtml(siteName)}</div>
              </td>
            </tr>
            <tr>
              <td>
                <h1 style="margin:0 0 8px;font-size:20px;color:#a5e8ff">${escapeHtml(heading)}</h1>
                ${
                  discordInviteUrl
                    ? `<p style="margin:0 0 14px">
                <a
                  href="${escapeHtml(discordInviteUrl)}"
                  target="_blank"
                  rel="noopener noreferrer"
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
                  ${escapeHtml(
                    discordLabel || "Join the Roo Industries Discord (Required)"
                  )}
                </a>
              </p>`
                    : ""
                }

                <p style="margin:10px 0 16px;opacity:.85">${escapeHtml(intro)}</p>
                <table cellpadding="0" cellspacing="0" style="width:100%;background:#0b1120;border:1px solid rgba(56,189,248,.15);border-radius:12px">
                  <tbody>
                    ${fields
                      .map(
                        (field) => `
                      <tr>
                        <td style="padding:10px 14px;color:#93c5fd;width:40%">${escapeHtml(field.label)}</td>
                        <td style="padding:10px 14px;color:#e5f2ff">${escapeHtml(field.value)}</td>
                      </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
                <p style="margin:18px 0 0;font-size:12px;color:#94a3b8">This is an automatic email from ${escapeHtml(siteName)}.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>
`;

const resolveLogoUrl = () =>
  String(process.env.LOGO_URL || DEFAULT_LOGO_URL).trim() || DEFAULT_LOGO_URL;

const buildEmailDispatchState = () => ({
  deliveryEnabled: false,
  deferred: false,
  client: {
    attempted: false,
    sent: false,
    skippedReason: "",
  },
  owner: {
    attempted: false,
    sent: false,
    skippedReason: "",
  },
  allSent: true,
});

const formatMoney = (value) =>
  Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "0.00";

const resolveBookingOwnerEmail = async (client) => {
  let owner = String(process.env.OWNER_EMAIL || "").trim();

  try {
    const settings = await client.fetch(
      `*[_type == "bookingSettings"][0]{ ownerEmail }`
    );
    const ownerFromSettings = String(settings?.ownerEmail || "").trim();
    if (ownerFromSettings) {
      owner = ownerFromSettings;
    }
  } catch (error) {
    console.error(
      "Failed to load booking owner email:",
      error?.message || error
    );
  }

  return owner;
};

export const getBookingForEmailDispatch = async ({
  bookingId,
  client = writeClient,
}) => {
  const normalizedBookingId = String(bookingId || "").trim();
  if (!normalizedBookingId) return null;

  return client.fetch(
    `*[_type == "booking" && _id == $id][0]{
      _id,
      discord,
      email,
      payerEmail,
      specs,
      mainGame,
      message,
      packageTitle,
      packagePrice,
      referralCode,
      discountPercent,
      discountAmount,
      grossAmount,
      netAmount,
      couponCode,
      couponDiscountPercent,
      couponDiscountAmount,
      hostDate,
      hostTime,
      hostTimeZone,
      localTimeZone,
      displayDate,
      displayTime,
      emailDispatchDeferred,
      emailDispatchStatus,
      emailDispatchQueuedAt,
      emailDispatchLastAttemptAt,
      emailDispatchLastError,
      emailDispatchClientSentAt,
      emailDispatchOwnerSentAt
    }`,
    { id: normalizedBookingId }
  );
};

export const buildDeferredEmailDispatch = ({ booking = {} }) => {
  const dispatch = buildEmailDispatchState();
  dispatch.deliveryEnabled = !!process.env.FROM_EMAIL && !!process.env.RESEND_API_KEY;
  dispatch.deferred = true;

  dispatch.client.sent = !!booking.emailDispatchClientSentAt;
  dispatch.owner.sent = !!booking.emailDispatchOwnerSentAt;

  dispatch.client.skippedReason = dispatch.client.sent
    ? "already_sent"
    : dispatch.deliveryEnabled
      ? "deferred_until_confirmation"
      : "delivery_disabled";
  dispatch.owner.skippedReason = dispatch.owner.sent
    ? "already_sent"
    : dispatch.deliveryEnabled
      ? "deferred_until_confirmation"
      : "delivery_disabled";

  dispatch.allSent = dispatch.client.sent && dispatch.owner.sent;
  return dispatch;
};

const buildBookingFieldGroups = (booking = {}) => {
  const siteName = process.env.SITE_NAME || "Roo Industries";
  const logoUrl = resolveLogoUrl();
  const discountPercentValue = Number(booking.discountPercent || 0);
  const discountAmountValue = Number(booking.discountAmount || 0);
  const couponPercentValue = Number(booking.couponDiscountPercent || 0);
  const couponAmountValue = Number(booking.couponDiscountAmount || 0);
  const couponSuffix =
    couponPercentValue > 0 || couponAmountValue > 0
      ? ` (${couponPercentValue}% - $${formatMoney(couponAmountValue)})`
      : "";
  const couponDisplay = booking.couponCode
    ? `${booking.couponCode}${couponSuffix}`
    : "-";
  const referralDisplay = String(booking.referralCode || "").trim() || "-";

  const sharedCoreFields = [
    { label: "Package", value: `${booking.packageTitle || "-"}` },
    {
      label: "Price",
      value:
        Number(booking.netAmount || 0) < Number(booking.grossAmount || 0)
          ? `$${formatMoney(booking.netAmount)} (was $${formatMoney(booking.grossAmount)})`
          : booking.packagePrice || "-",
    },
    { label: "Discord", value: booking.discord || "-" },
    { label: "Email", value: booking.email || booking.payerEmail || "-" },
    { label: "Main Game", value: booking.mainGame || "-" },
    { label: "PC Specs", value: booking.specs || "-" },
    { label: "Notes", value: booking.message || "-" },
    { label: "Referral Code", value: referralDisplay },
    { label: "Coupon Code", value: couponDisplay },
    { label: "Order ID", value: booking._id || "-" },
  ];

  const ownerDiscountFields = [];
  if (discountPercentValue > 0 || discountAmountValue > 0) {
    ownerDiscountFields.push({
      label: "Discount",
      value: `${discountPercentValue}% ($${formatMoney(discountAmountValue)})`,
    });
  }

  const clientFields = [
    { label: "Date", value: booking.displayDate || "-" },
    { label: "Time", value: booking.displayTime || "-" },
    ...(booking.localTimeZone
      ? [{ label: "Time Zone", value: booking.localTimeZone }]
      : []),
    ...sharedCoreFields,
  ];

  const ownerFields = [
    { label: "Client Date", value: booking.displayDate || "-" },
    { label: "Client Time", value: booking.displayTime || "-" },
    ...(booking.localTimeZone
      ? [{ label: "Client Time Zone", value: booking.localTimeZone }]
      : []),
    { label: "Date", value: booking.hostDate || "-" },
    { label: "Time", value: booking.hostTime || "-" },
    { label: "Time Zone", value: booking.hostTimeZone || OWNER_TZ_NAME },
    ...ownerDiscountFields,
    ...sharedCoreFields,
  ];

  const bookingRef = String(booking._id || "").slice(-6).toUpperCase() || "BOOKING";

  return {
    siteName,
    logoUrl,
    bookingRef,
    clientFields,
    ownerFields,
  };
};

export const sendBookingEmailsForBooking = async ({
  bookingId,
  client = writeClient,
  booking = null,
}) => {
  const resolvedBooking =
    booking && booking._id === bookingId
      ? booking
      : await getBookingForEmailDispatch({ bookingId, client });

  if (!resolvedBooking?._id) {
    return {
      httpStatus: 404,
      body: {
        ok: false,
        error: "Booking not found.",
      },
    };
  }

  const dispatch = buildEmailDispatchState();
  dispatch.deliveryEnabled = !!process.env.FROM_EMAIL && !!process.env.RESEND_API_KEY;
  const now = new Date().toISOString();
  const patchValues = {
    emailDispatchLastAttemptAt: now,
    emailDispatchLastError: "",
  };

  const owner = await resolveBookingOwnerEmail(client);
  const { siteName, logoUrl, bookingRef, clientFields, ownerFields } =
    buildBookingFieldGroups(resolvedBooking);
  const from = process.env.FROM_EMAIL;
  const clientRecipient = String(
    resolvedBooking.email || resolvedBooking.payerEmail || ""
  ).trim();
  const clientAlreadySent = !!resolvedBooking.emailDispatchClientSentAt;
  const ownerAlreadySent = !!resolvedBooking.emailDispatchOwnerSentAt;

  if (!dispatch.deliveryEnabled) {
    dispatch.deferred = !!resolvedBooking.emailDispatchDeferred;
    dispatch.client.sent = clientAlreadySent;
    dispatch.owner.sent = ownerAlreadySent;
    dispatch.client.skippedReason = clientAlreadySent
      ? "already_sent"
      : "delivery_disabled";
    dispatch.owner.skippedReason = ownerAlreadySent
      ? "already_sent"
      : "delivery_disabled";
    dispatch.allSent = dispatch.client.sent && dispatch.owner.sent;
    patchValues.emailDispatchStatus = dispatch.allSent ? "sent" : "delivery_disabled";
    patchValues.emailDispatchDeferred = false;
    await client.patch(resolvedBooking._id).set(patchValues).commit();
    return {
      httpStatus: 200,
      body: {
        ok: true,
        bookingId: resolvedBooking._id,
        emailDispatch: dispatch,
      },
    };
  }

  if (clientAlreadySent) {
    dispatch.client.sent = true;
    dispatch.client.skippedReason = "already_sent";
  } else if (!clientRecipient) {
    dispatch.client.skippedReason = "missing_client_recipient";
  } else {
    dispatch.client.attempted = true;
    try {
      const { error } = await resend.emails.send({
        from,
        to: clientRecipient,
        subject: `Your ${siteName} booking`,
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
        dispatch.client.skippedReason =
          error?.message || error?.name || "resend_client_error";
      } else {
        dispatch.client.sent = true;
        patchValues.emailDispatchClientSentAt = now;
      }
    } catch (error) {
      dispatch.client.skippedReason =
        error?.message || "resend_client_exception";
    }
  }

  if (ownerAlreadySent) {
    dispatch.owner.sent = true;
    dispatch.owner.skippedReason = "already_sent";
  } else if (!owner) {
    dispatch.owner.skippedReason = "missing_owner_recipient";
  } else {
    dispatch.owner.attempted = true;
    try {
      const { error } = await resend.emails.send({
        from,
        to: owner,
        subject: `New booking ${bookingRef} - ${resolvedBooking.packageTitle} (${resolvedBooking.hostDate} ${resolvedBooking.hostTime})`,
        html: emailHtml({
          logoUrl,
          siteName,
          heading: "New Booking Received",
          intro: "A new booking was submitted:",
          fields: ownerFields,
        }),
      });

      if (error) {
        dispatch.owner.skippedReason =
          error?.message || error?.name || "resend_owner_error";
      } else {
        dispatch.owner.sent = true;
        patchValues.emailDispatchOwnerSentAt = now;
      }
    } catch (error) {
      dispatch.owner.skippedReason =
        error?.message || "resend_owner_exception";
    }
  }

  const lastErrors = [dispatch.client.skippedReason, dispatch.owner.skippedReason]
    .filter((reason) => reason && reason !== "already_sent")
    .join(" | ");
  dispatch.allSent = dispatch.client.sent && dispatch.owner.sent;
  dispatch.deferred = false;

  patchValues.emailDispatchStatus = dispatch.allSent
    ? "sent"
    : dispatch.client.sent || dispatch.owner.sent
      ? "partial"
      : "failed";
  patchValues.emailDispatchDeferred = false;
  patchValues.emailDispatchLastError = lastErrors;

  await client.patch(resolvedBooking._id).set(patchValues).commit();

  return {
    httpStatus: 200,
    body: {
      ok: true,
      bookingId: resolvedBooking._id,
      emailDispatch: dispatch,
    },
  };
};
