import { createDataClient as createClient } from "../../data/documentClient.js";
import { Resend } from "resend";
import crypto from "crypto";
import { getSafeErrorCode, logSafeError } from "../../safeErrorLog.js";
import {
  claimEmailDispatchPair,
  completeEmailDispatch,
  listEmailDispatchRecoveryBookingIds,
} from "../../supabase/emailDispatchLedger.js";

const writeClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
}, { domain: "commerce" });

export const DISCORD_INVITE_URL = "https://discord.com/invite/qs5HKNyazD";
export const OWNER_TZ_NAME = "Asia/Kolkata";
const DEFAULT_LOGO_URL = "https://www.rooindustries.com/embed_logo.png";

const hasEmailDeliveryConfig = () =>
  !!String(process.env.FROM_EMAIL || "").trim() &&
  !!String(process.env.RESEND_API_KEY || "").trim();

const createResendClient = () => {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  return apiKey ? new Resend(apiKey) : null;
};

const resend = createResendClient();

const flushCriticalBookingMirror = async (client) => {
  if (typeof client?.flushCommerceMirror !== "function") return null;
  return client.flushCommerceMirror({ failClosed: true, limit: 100 });
};

const recordEmailLedgerOutcome = async ({
  client,
  dispatch,
  leaseId,
  success,
  providerMessageId = "",
  errorCode = "",
  sentAt,
  nextAttemptAt,
}) => {
  try {
    return await completeEmailDispatch({
      client,
      dispatch,
      leaseId,
      success,
      providerMessageId,
      errorCode,
      sentAt,
      nextAttemptAt,
    });
  } catch (error) {
    logSafeError("Email dispatch ledger update failed", error);
    return null;
  }
};

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

export const formatRequestedTimeFields = (booking = {}) => {
  const requestedAt = new Date(
    String(booking.originalRequestedStartTimeUTC || "").trim()
  );
  if (!Number.isFinite(requestedAt.getTime())) {
    return [{ label: "Time Selected", value: "Unavailable" }];
  }

  const requestedTimeZone = String(booking.localTimeZone || "").trim();
  let timeZone = "UTC";
  if (requestedTimeZone) {
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: requestedTimeZone,
      }).format(requestedAt);
      timeZone = requestedTimeZone;
    } catch {
      timeZone = "UTC";
    }
  }

  const canUseStoredLabels = timeZone !== "UTC";
  const requestedDate =
    (canUseStoredLabels && String(booking.displayDate || "").trim()) ||
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(requestedAt);
  const requestedTime =
    (canUseStoredLabels && String(booking.displayTime || "").trim()) ||
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(requestedAt);
  const timeZoneName =
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "long",
    })
      .formatToParts(requestedAt)
      .find((part) => part.type === "timeZoneName")?.value || timeZone;
  const timeZoneDisplay =
    timeZone === "UTC" ? "UTC" : `${timeZoneName} (${timeZone})`;

  return [
    { label: "Requested Date", value: requestedDate },
    { label: "Requested Time", value: requestedTime },
    { label: "Time Zone", value: timeZoneDisplay },
  ];
};

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
    logSafeError("Booking owner email lookup failed", error);
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
      _rev,
      backendOwner,
      cutoverGeneration,
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
      couponDiscountType,
      couponDiscountValue,
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
      emailDispatchAttemptCount,
      emailDispatchNextAttemptAt,
      emailDispatchLeaseId,
      emailDispatchLeaseExpiresAt,
      emailDispatchClientSentAt,
      emailDispatchOwnerSentAt,
      emailDispatchClientProviderId,
      emailDispatchOwnerProviderId
    }`,
    { id: normalizedBookingId }
  );
};

export const buildDeferredEmailDispatch = ({ booking = {} }) => {
  const dispatch = buildEmailDispatchState();
  dispatch.deliveryEnabled = hasEmailDeliveryConfig();
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

const hasRenderableBookingEmailFields = (booking = {}) =>
  !!booking?._id &&
  !!String(booking.packageTitle || "").trim() &&
  !!String(booking.packagePrice || "").trim() &&
  !!String(booking.hostDate || "").trim() &&
  !!String(booking.hostTime || "").trim() &&
  !!String(booking.hostTimeZone || "").trim() &&
  !!String(booking.displayDate || "").trim() &&
  !!String(booking.displayTime || "").trim() &&
  !!String(booking.localTimeZone || "").trim() &&
  !!String(booking.email || booking.payerEmail || "").trim();

const buildBookingFieldGroups = (booking = {}) => {
  const siteName = process.env.SITE_NAME || "Roo Industries";
  const logoUrl = resolveLogoUrl();
  const discountPercentValue = Number(booking.discountPercent || 0);
  const discountAmountValue = Number(booking.discountAmount || 0);
  const couponPercentValue = Number(booking.couponDiscountPercent || 0);
  const couponAmountValue = Number(booking.couponDiscountAmount || 0);
  const couponType = String(booking.couponDiscountType || "").trim().toLowerCase();
  const couponValue = Number(booking.couponDiscountValue || 0);
  const couponSuffix =
    couponPercentValue > 0 || couponAmountValue > 0
      ? couponType === "fixed"
        ? ` ($${formatMoney(couponValue || couponAmountValue)} off - $${formatMoney(couponAmountValue)})`
        : ` (${couponPercentValue}% - $${formatMoney(couponAmountValue)})`
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
  const suppliedBooking =
    booking && booking._id === bookingId && hasRenderableBookingEmailFields(booking)
      ? booking
      : null;
  const resolvedBooking =
    (await getBookingForEmailDispatch({ bookingId, client })) || suppliedBooking;

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
  dispatch.deliveryEnabled = !!String(process.env.FROM_EMAIL || "").trim() && !!resend;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const existingLeaseExpiresAt = new Date(
    resolvedBooking.emailDispatchLeaseExpiresAt || ""
  ).getTime();
  if (
    resolvedBooking.emailDispatchLeaseId &&
    Number.isFinite(existingLeaseExpiresAt) &&
    existingLeaseExpiresAt > nowMs
  ) {
    return {
      httpStatus: 202,
      body: {
        ok: true,
        bookingId: resolvedBooking._id,
        retryable: true,
        emailDispatch: {
          ...buildDeferredEmailDispatch({ booking: resolvedBooking }),
          skippedReason: "dispatch_in_progress",
        },
      },
    };
  }

  const leaseId = crypto.randomUUID();
  const leaseExpiresAt = new Date(nowMs + 2 * 60 * 1000).toISOString();
  try {
    let leasePatch = client.patch(resolvedBooking._id);
    if (resolvedBooking._rev && typeof leasePatch.ifRevisionId === "function") {
      leasePatch = leasePatch.ifRevisionId(resolvedBooking._rev);
    }
    await leasePatch
      .set({
        emailDispatchLeaseId: leaseId,
        emailDispatchLeaseExpiresAt: leaseExpiresAt,
        emailDispatchLastAttemptAt: now,
      })
      .setIfMissing({ emailDispatchAttemptCount: 0 })
      .inc({ emailDispatchAttemptCount: 1 })
      .commit();
  } catch (error) {
    if (Number(error?.statusCode || error?.status || 0) === 409) {
      return {
        httpStatus: 202,
        body: {
          ok: true,
          bookingId: resolvedBooking._id,
          retryable: true,
          emailDispatch: {
            ...buildDeferredEmailDispatch({ booking: resolvedBooking }),
            skippedReason: "dispatch_in_progress",
          },
        },
      };
    }
    throw error;
  }

  try {
    await flushCriticalBookingMirror(client);
  } catch (error) {
    await client
      .patch(resolvedBooking._id)
      .set({
        emailDispatchStatus: "retry",
        emailDispatchLastError: "sanity_mirror_pending_before_email",
        emailDispatchLeaseId: "",
        emailDispatchLeaseExpiresAt: "",
        emailDispatchNextAttemptAt: new Date(nowMs + 5 * 60 * 1000).toISOString(),
      })
      .commit()
      .catch(() => null);
    return {
      httpStatus: 503,
      body: {
        ok: false,
        bookingId: resolvedBooking._id,
        retryable: true,
        code: "sanity_mirror_pending_before_email",
        error: "Booking confirmation is saved and will retry shortly.",
        emailDispatch: buildDeferredEmailDispatch({ booking: resolvedBooking }),
      },
    };
  }

  let ledger = null;
  try {
    ledger = await claimEmailDispatchPair({
      client,
      bookingId: resolvedBooking._id,
      dispatchKind: "booking_confirmation",
      leaseId,
    });
  } catch (error) {
    logSafeError("Booking email ledger lease failed", error);
    await client
      .patch(resolvedBooking._id)
      .set({
        emailDispatchStatus: "retry",
        emailDispatchLastError: "email_ledger_unavailable",
        emailDispatchLeaseId: "",
        emailDispatchLeaseExpiresAt: "",
        emailDispatchNextAttemptAt: new Date(
          nowMs + 5 * 60 * 1000
        ).toISOString(),
      })
      .commit()
      .catch(() => null);
    return {
      httpStatus: 503,
      body: {
        ok: false,
        bookingId: resolvedBooking._id,
        retryable: true,
        code: "email_ledger_unavailable",
        error: "Booking confirmation is saved and will retry shortly.",
        emailDispatch: buildDeferredEmailDispatch({ booking: resolvedBooking }),
      },
    };
  }
  if (ledger?.customer?.inProgress || ledger?.owner?.inProgress) {
    await client
      .patch(resolvedBooking._id)
      .set({
        emailDispatchLeaseId: "",
        emailDispatchLeaseExpiresAt: "",
      })
      .commit()
      .catch(() => null);
    return {
      httpStatus: 202,
      body: {
        ok: true,
        bookingId: resolvedBooking._id,
        retryable: true,
        emailDispatch: {
          ...buildDeferredEmailDispatch({ booking: resolvedBooking }),
          skippedReason: "dispatch_in_progress",
        },
      },
    };
  }

  const patchValues = {
    emailDispatchLastAttemptAt: now,
    emailDispatchLastError: "",
  };

  const owner = await resolveBookingOwnerEmail(client);
  const { siteName, logoUrl, bookingRef, clientFields, ownerFields } =
    buildBookingFieldGroups(resolvedBooking);
  const from = process.env.FROM_EMAIL;
  const ownerScheduleLabel =
    [resolvedBooking.hostDate, resolvedBooking.hostTime]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" ") || "time TBD";
  const clientRecipient = String(
    resolvedBooking.email || resolvedBooking.payerEmail || ""
  ).trim();
  const clientAlreadySent =
    !!resolvedBooking.emailDispatchClientSentAt || ledger?.customer?.sent === true;
  const ownerAlreadySent =
    !!resolvedBooking.emailDispatchOwnerSentAt || ledger?.owner?.sent === true;
  if (!resolvedBooking.emailDispatchClientSentAt && ledger?.customer?.sent) {
    patchValues.emailDispatchClientSentAt = ledger.customer.sentAt || now;
    if (ledger.customer.providerMessageId) {
      patchValues.emailDispatchClientProviderId =
        ledger.customer.providerMessageId;
    }
  }
  if (!resolvedBooking.emailDispatchOwnerSentAt && ledger?.owner?.sent) {
    patchValues.emailDispatchOwnerSentAt = ledger.owner.sentAt || now;
    if (ledger.owner.providerMessageId) {
      patchValues.emailDispatchOwnerProviderId = ledger.owner.providerMessageId;
    }
  }

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
    patchValues.emailDispatchLeaseId = "";
    patchValues.emailDispatchLeaseExpiresAt = "";
    patchValues.emailDispatchNextAttemptAt = dispatch.allSent
      ? ""
      : new Date(nowMs + 5 * 60 * 1000).toISOString();
    await client.patch(resolvedBooking._id).set(patchValues).commit();
    await flushCriticalBookingMirror(client).catch(() => null);
    return {
      httpStatus: dispatch.allSent ? 200 : 503,
      body: {
        ok: dispatch.allSent,
        bookingId: resolvedBooking._id,
        retryable: !dispatch.allSent,
        emailDispatch: dispatch,
      },
    };
  }

  if (clientAlreadySent) {
    dispatch.client.sent = true;
    dispatch.client.skippedReason = "already_sent";
  } else if (ledger?.customer?.historicalUnknown) {
    dispatch.client.skippedReason = "historical_delivery_unknown";
  } else if (ledger && !ledger.customer?.claimed) {
    dispatch.client.skippedReason = "dispatch_in_progress";
  } else if (!clientRecipient) {
    dispatch.client.skippedReason = "missing_client_recipient";
  } else {
    dispatch.client.attempted = true;
    try {
      const { data, error } = await resend.emails.send(
        {
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
        },
        {
          idempotencyKey:
            ledger?.customer?.idempotencyKey ||
            `booking-${resolvedBooking._id}-client`,
        }
      );

      if (error) {
        const errorCode = getSafeErrorCode(error, "resend_client_error");
        dispatch.client.skippedReason = errorCode;
        await recordEmailLedgerOutcome({
          client,
          dispatch: ledger?.customer,
          leaseId,
          success: false,
          errorCode,
          nextAttemptAt: new Date(nowMs + 5 * 60 * 1000).toISOString(),
        });
      } else {
        dispatch.client.sent = true;
        patchValues.emailDispatchClientSentAt = now;
        if (data?.id) patchValues.emailDispatchClientProviderId = String(data.id);
        await recordEmailLedgerOutcome({
          client,
          dispatch: ledger?.customer,
          leaseId,
          success: true,
          providerMessageId: data?.id,
          sentAt: now,
        });
      }
    } catch (error) {
      const errorCode = getSafeErrorCode(
        error,
        "resend_client_exception"
      );
      dispatch.client.skippedReason = errorCode;
      await recordEmailLedgerOutcome({
        client,
        dispatch: ledger?.customer,
        leaseId,
        success: false,
        errorCode,
        nextAttemptAt: new Date(nowMs + 5 * 60 * 1000).toISOString(),
      });
    }
  }

  if (ownerAlreadySent) {
    dispatch.owner.sent = true;
    dispatch.owner.skippedReason = "already_sent";
  } else if (ledger?.owner?.historicalUnknown) {
    dispatch.owner.skippedReason = "historical_delivery_unknown";
  } else if (ledger && !ledger.owner?.claimed) {
    dispatch.owner.skippedReason = "dispatch_in_progress";
  } else if (!owner) {
    dispatch.owner.skippedReason = "missing_owner_recipient";
  } else {
    dispatch.owner.attempted = true;
    try {
      const { data, error } = await resend.emails.send(
        {
          from,
          to: owner,
          subject: `New booking ${bookingRef} - ${resolvedBooking.packageTitle} (${ownerScheduleLabel})`,
          html: emailHtml({
            logoUrl,
            siteName,
            heading: "New Booking Received",
            intro: "A new booking was submitted:",
            fields: ownerFields,
          }),
        },
        {
          idempotencyKey:
            ledger?.owner?.idempotencyKey ||
            `booking-${resolvedBooking._id}-owner`,
        }
      );

      if (error) {
        const errorCode = getSafeErrorCode(error, "resend_owner_error");
        dispatch.owner.skippedReason = errorCode;
        await recordEmailLedgerOutcome({
          client,
          dispatch: ledger?.owner,
          leaseId,
          success: false,
          errorCode,
          nextAttemptAt: new Date(nowMs + 5 * 60 * 1000).toISOString(),
        });
      } else {
        dispatch.owner.sent = true;
        patchValues.emailDispatchOwnerSentAt = now;
        if (data?.id) patchValues.emailDispatchOwnerProviderId = String(data.id);
        await recordEmailLedgerOutcome({
          client,
          dispatch: ledger?.owner,
          leaseId,
          success: true,
          providerMessageId: data?.id,
          sentAt: now,
        });
      }
    } catch (error) {
      const errorCode = getSafeErrorCode(
        error,
        "resend_owner_exception"
      );
      dispatch.owner.skippedReason = errorCode;
      await recordEmailLedgerOutcome({
        client,
        dispatch: ledger?.owner,
        leaseId,
        success: false,
        errorCode,
        nextAttemptAt: new Date(nowMs + 5 * 60 * 1000).toISOString(),
      });
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
  patchValues.emailDispatchLeaseId = "";
  patchValues.emailDispatchLeaseExpiresAt = "";
  patchValues.emailDispatchNextAttemptAt = dispatch.allSent
    ? ""
    : new Date(nowMs + 5 * 60 * 1000).toISOString();

  const latestBooking = await getBookingForEmailDispatch({
    bookingId: resolvedBooking._id,
    client,
  });
  if (!latestBooking?.emailDispatchLeaseId || latestBooking.emailDispatchLeaseId === leaseId) {
    let completionPatch = client.patch(resolvedBooking._id);
    if (latestBooking?._rev && typeof completionPatch.ifRevisionId === "function") {
      completionPatch = completionPatch.ifRevisionId(latestBooking._rev);
    }
    await completionPatch.set(patchValues).commit();
  }

  try {
    await flushCriticalBookingMirror(client);
  } catch {
    return {
      httpStatus: 503,
      body: {
        ok: false,
        bookingId: resolvedBooking._id,
        retryable: true,
        code: "sanity_mirror_pending_after_email",
        error: "Email delivery is recorded and its fallback copy will retry.",
        emailDispatch: dispatch,
      },
    };
  }

  return {
    httpStatus: dispatch.allSent ? 200 : 503,
    body: {
      ok: dispatch.allSent,
      bookingId: resolvedBooking._id,
      retryable: !dispatch.allSent,
      emailDispatch: dispatch,
    },
  };
};

export const reconcileBookingEmailDispatches = async ({
  client = writeClient,
  now = new Date().toISOString(),
  limit = 20,
} = {}) => {
  const ledgerBookingIds = await listEmailDispatchRecoveryBookingIds({
    client,
    dispatchKind: "booking_confirmation",
    now,
    limit,
  });
  const bookings = Array.isArray(ledgerBookingIds)
    ? await client.fetch(
        `*[_type == "booking" && _id in $ids]{...}`,
        { ids: ledgerBookingIds }
      )
    : await client.fetch(
        `*[_type == "booking"
          && emailDispatchStatus in ["partial", "failed", "retry"]
          && (!defined(emailDispatchNextAttemptAt) || emailDispatchNextAttemptAt == "" || emailDispatchNextAttemptAt <= $now)
          && (!defined(emailDispatchClientSentAt) || !defined(emailDispatchOwnerSentAt))
        ] | order(emailDispatchNextAttemptAt asc, _updatedAt asc)[0...20]{...}`,
        { now }
      );
  const summary = { scanned: 0, sent: 0, pending: 0 };
  const byId = new Map(
    (Array.isArray(bookings) ? bookings : []).map((booking) => [
      booking?._id,
      booking,
    ])
  );
  const ordered = Array.isArray(ledgerBookingIds)
    ? ledgerBookingIds.map((id) => byId.get(id)).filter(Boolean)
    : Array.isArray(bookings)
      ? bookings
      : [];
  const selected = ordered.slice(0, Math.max(1, Math.min(20, Number(limit) || 20)));
  for (const booking of selected) {
    summary.scanned += 1;
    const result = await sendBookingEmailsForBooking({
      bookingId: booking._id,
      booking,
      client,
    });
    if (result?.body?.emailDispatch?.allSent === true) summary.sent += 1;
    else summary.pending += 1;
  }
  return summary;
};

export const dispatchRescheduleNotifications = async ({
  client = writeClient,
  bookingId,
  booking = null,
}) => {
  const recoveryBooking =
    booking?._id === bookingId
      ? booking
      : await client.fetch(
          `*[_type == "booking" && _id == $id][0]{...}`,
          { id: bookingId }
        );
  if (!recoveryBooking?._id) {
    return { ok: false, notificationRequired: true, reason: "booking_missing" };
  }
  if (
    recoveryBooking.recoveryClientNotifiedAt &&
    recoveryBooking.recoveryOwnerNotifiedAt
  ) {
    return {
      ok: true,
      notificationRequired: false,
      idempotent: true,
      bookingId: recoveryBooking._id,
    };
  }

  const nowMs = Date.now();
  const leaseExpiry = new Date(
    recoveryBooking.recoveryNotificationLeaseExpiresAt || ""
  ).getTime();
  if (
    recoveryBooking.recoveryNotificationLeaseId &&
    Number.isFinite(leaseExpiry) &&
    leaseExpiry > nowMs
  ) {
    return {
      ok: true,
      notificationRequired: true,
      inProgress: true,
      bookingId: recoveryBooking._id,
    };
  }

  const leaseId = crypto.randomUUID();
  const now = new Date(nowMs).toISOString();
  try {
    let leasePatch = client.patch(recoveryBooking._id);
    if (recoveryBooking._rev && typeof leasePatch.ifRevisionId === "function") {
      leasePatch = leasePatch.ifRevisionId(recoveryBooking._rev);
    }
    await leasePatch
      .set({
        recoveryNotificationLeaseId: leaseId,
        recoveryNotificationLeaseExpiresAt: new Date(
          nowMs + 2 * 60 * 1000
        ).toISOString(),
        recoveryNotificationLastAttemptAt: now,
      })
      .setIfMissing({ recoveryNotificationAttemptCount: 0 })
      .inc({ recoveryNotificationAttemptCount: 1 })
      .commit();
  } catch (error) {
    if (Number(error?.statusCode || error?.status || 0) === 409) {
      return {
        ok: true,
        notificationRequired: true,
        inProgress: true,
        bookingId: recoveryBooking._id,
      };
    }
    throw error;
  }

  try {
    await flushCriticalBookingMirror(client);
  } catch {
    await client
      .patch(recoveryBooking._id)
      .set({
        recoveryNotificationStatus: "pending",
        recoveryNotificationLastError: "sanity_mirror_pending_before_email",
        recoveryNotificationLeaseId: "",
        recoveryNotificationLeaseExpiresAt: "",
        recoveryNotificationNextAttemptAt: new Date(
          nowMs + 5 * 60 * 1000
        ).toISOString(),
      })
      .commit()
      .catch(() => null);
    return {
      ok: false,
      bookingId: recoveryBooking._id,
      notificationRequired: true,
      reason: "sanity_mirror_pending_before_email",
    };
  }

  let recoveryLedger = null;
  try {
    recoveryLedger = await claimEmailDispatchPair({
      client,
      bookingId: recoveryBooking._id,
      dispatchKind: "reschedule",
      leaseId,
    });
  } catch (error) {
    logSafeError("Reschedule email ledger lease failed", error);
    await client
      .patch(recoveryBooking._id)
      .set({
        recoveryNotificationStatus: "pending",
        recoveryNotificationLastError: "email_ledger_unavailable",
        recoveryNotificationLeaseId: "",
        recoveryNotificationLeaseExpiresAt: "",
        recoveryNotificationNextAttemptAt: new Date(
          nowMs + 5 * 60 * 1000
        ).toISOString(),
      })
      .commit()
      .catch(() => null);
    return {
      ok: false,
      bookingId: recoveryBooking._id,
      notificationRequired: true,
      reason: "email_ledger_unavailable",
    };
  }
  if (recoveryLedger?.customer?.inProgress || recoveryLedger?.owner?.inProgress) {
    await client
      .patch(recoveryBooking._id)
      .set({
        recoveryNotificationLeaseId: "",
        recoveryNotificationLeaseExpiresAt: "",
      })
      .commit()
      .catch(() => null);
    return {
      ok: true,
      notificationRequired: true,
      inProgress: true,
      bookingId: recoveryBooking._id,
    };
  }

  const owner = await resolveBookingOwnerEmail(client);
  const customer = String(
    recoveryBooking.email || recoveryBooking.payerEmail || ""
  ).trim();
  const siteName = process.env.SITE_NAME || "Roo Industries";
  const from = String(process.env.FROM_EMAIL || "").trim();
  const deliveryEnabled = !!from && !!resend;
  const amount = formatMoney(
    recoveryBooking.netAmount || recoveryBooking.grossAmount || 0
  );
  const fields = [
    { label: "Order ID", value: recoveryBooking._id },
    { label: "Package", value: recoveryBooking.packageTitle || "-" },
    { label: "Paid Amount", value: `$${amount}` },
    ...formatRequestedTimeFields(recoveryBooking),
  ];
  const patchValues = {
    recoveryNotificationLeaseId: "",
    recoveryNotificationLeaseExpiresAt: "",
    recoveryNotificationLastAttemptAt: now,
  };
  const errors = [];
  const clientAlreadyNotified =
    !!recoveryBooking.recoveryClientNotifiedAt ||
    recoveryLedger?.customer?.sent === true;
  const ownerAlreadyNotified =
    !!recoveryBooking.recoveryOwnerNotifiedAt ||
    recoveryLedger?.owner?.sent === true;
  if (!recoveryBooking.recoveryClientNotifiedAt && recoveryLedger?.customer?.sent) {
    patchValues.recoveryClientNotifiedAt = recoveryLedger.customer.sentAt || now;
    if (recoveryLedger.customer.providerMessageId) {
      patchValues.recoveryClientProviderId =
        recoveryLedger.customer.providerMessageId;
    }
  }
  if (!recoveryBooking.recoveryOwnerNotifiedAt && recoveryLedger?.owner?.sent) {
    patchValues.recoveryOwnerNotifiedAt = recoveryLedger.owner.sentAt || now;
    if (recoveryLedger.owner.providerMessageId) {
      patchValues.recoveryOwnerProviderId = recoveryLedger.owner.providerMessageId;
    }
  }

  if (!deliveryEnabled) {
    errors.push("delivery_disabled");
  } else {
    if (clientAlreadyNotified) {
      // The typed ledger is the final authority when the compatibility patch lagged.
    } else if (recoveryLedger?.customer?.historicalUnknown) {
      errors.push("historical_delivery_unknown");
    } else if (recoveryLedger && !recoveryLedger.customer?.claimed) {
      errors.push("dispatch_in_progress");
    } else if (customer) {
      try {
        const { data, error } = await resend.emails.send(
          {
            from,
            to: customer,
            subject: `We need to reschedule your ${siteName} booking`,
            html: emailHtml({
              logoUrl: resolveLogoUrl(),
              siteName,
              heading: "We need to reschedule your booking",
              intro:
                "Your payment went through, but we couldn't confirm the time you selected. Reply to this email or join the Roo Industries Discord and we'll arrange another time. You won't be charged again.",
              fields,
              discordInviteUrl: DISCORD_INVITE_URL,
              discordLabel: "Open the Roo Industries Discord",
            }),
          },
          {
            idempotencyKey:
              recoveryLedger?.customer?.idempotencyKey ||
              `booking-${recoveryBooking._id}-reschedule-client`,
          }
        );
        if (error) {
          const errorCode = getSafeErrorCode(error, "reschedule_client_error");
          errors.push(errorCode);
          await recordEmailLedgerOutcome({
            client,
            dispatch: recoveryLedger?.customer,
            leaseId,
            success: false,
            errorCode,
            nextAttemptAt: new Date(nowMs + 5 * 60 * 1000).toISOString(),
          });
        } else {
          patchValues.recoveryClientNotifiedAt = now;
          if (data?.id) patchValues.recoveryClientProviderId = String(data.id);
          await recordEmailLedgerOutcome({
            client,
            dispatch: recoveryLedger?.customer,
            leaseId,
            success: true,
            providerMessageId: data?.id,
            sentAt: now,
          });
        }
      } catch (error) {
        const errorCode = getSafeErrorCode(
          error,
          "reschedule_client_exception"
        );
        errors.push(errorCode);
        await recordEmailLedgerOutcome({
          client,
          dispatch: recoveryLedger?.customer,
          leaseId,
          success: false,
          errorCode,
          nextAttemptAt: new Date(nowMs + 5 * 60 * 1000).toISOString(),
        });
      }
    } else {
      errors.push("missing_client_recipient");
    }

    if (ownerAlreadyNotified) {
      // Already recorded by the authoritative dispatch ledger.
    } else if (recoveryLedger?.owner?.historicalUnknown) {
      errors.push("historical_delivery_unknown");
    } else if (recoveryLedger && !recoveryLedger.owner?.claimed) {
      errors.push("dispatch_in_progress");
    } else if (owner) {
      try {
        const { data, error } = await resend.emails.send(
          {
            from,
            to: owner,
            subject: `Paid booking requires reschedule - ${recoveryBooking._id}`,
            html: emailHtml({
              logoUrl: resolveLogoUrl(),
              siteName,
              heading: "Captured payment requires manual rescheduling",
              intro:
                "The payment was captured, but the original booking slot could not be reconstructed or is no longer available. Contact the customer and assign a new time.",
              fields: [
                ...fields,
                { label: "Customer Email", value: customer || "Unavailable" },
                {
                  label: "Recovery Reason",
                  value: recoveryBooking.recoveryReason || "Unavailable",
                },
              ],
            }),
          },
          {
            idempotencyKey:
              recoveryLedger?.owner?.idempotencyKey ||
              `booking-${recoveryBooking._id}-reschedule-owner`,
          }
        );
        if (error) {
          const errorCode = getSafeErrorCode(error, "reschedule_owner_error");
          errors.push(errorCode);
          await recordEmailLedgerOutcome({
            client,
            dispatch: recoveryLedger?.owner,
            leaseId,
            success: false,
            errorCode,
            nextAttemptAt: new Date(nowMs + 5 * 60 * 1000).toISOString(),
          });
        } else {
          patchValues.recoveryOwnerNotifiedAt = now;
          if (data?.id) patchValues.recoveryOwnerProviderId = String(data.id);
          await recordEmailLedgerOutcome({
            client,
            dispatch: recoveryLedger?.owner,
            leaseId,
            success: true,
            providerMessageId: data?.id,
            sentAt: now,
          });
        }
      } catch (error) {
        const errorCode = getSafeErrorCode(
          error,
          "reschedule_owner_exception"
        );
        errors.push(errorCode);
        await recordEmailLedgerOutcome({
          client,
          dispatch: recoveryLedger?.owner,
          leaseId,
          success: false,
          errorCode,
          nextAttemptAt: new Date(nowMs + 5 * 60 * 1000).toISOString(),
        });
      }
    } else {
      errors.push("missing_owner_recipient");
    }
  }

  const clientSent =
    clientAlreadyNotified ||
    !!patchValues.recoveryClientNotifiedAt;
  const ownerSent =
    ownerAlreadyNotified ||
    !!patchValues.recoveryOwnerNotifiedAt;
  const allSent = clientSent && ownerSent;
  patchValues.recoveryNotificationStatus = allSent
    ? "sent"
    : clientSent || ownerSent
      ? "partial"
      : "pending";
  patchValues.recoveryNotificationLastError = errors.join(" | ");
  patchValues.recoveryNotificationNextAttemptAt = allSent
    ? ""
    : new Date(nowMs + 5 * 60 * 1000).toISOString();

  const latest = await client.fetch(
    `*[_type == "booking" && _id == $id][0]{_id,_rev,recoveryNotificationLeaseId}`,
    { id: recoveryBooking._id }
  );
  if (!latest?.recoveryNotificationLeaseId || latest.recoveryNotificationLeaseId === leaseId) {
    let completionPatch = client.patch(recoveryBooking._id);
    if (latest?._rev && typeof completionPatch.ifRevisionId === "function") {
      completionPatch = completionPatch.ifRevisionId(latest._rev);
    }
    await completionPatch.set(patchValues).commit();
  }
  const recoveryCase = await client.fetch(
    `*[_type == "bookingRecoveryCase" && bookingId == $bookingId][0]{_id,_rev}`,
    { bookingId: recoveryBooking._id }
  );
  if (recoveryCase?._id) {
    let casePatch = client.patch(recoveryCase._id);
    if (recoveryCase._rev && typeof casePatch.ifRevisionId === "function") {
      casePatch = casePatch.ifRevisionId(recoveryCase._rev);
    }
    await casePatch
      .set({
        notificationStatus: patchValues.recoveryNotificationStatus,
        ...(allSent ? { notifiedAt: now, status: "notified" } : {}),
      })
      .commit()
      .catch(() => {});
  }

  try {
    await flushCriticalBookingMirror(client);
  } catch {
    return {
      ok: false,
      bookingId: recoveryBooking._id,
      notificationRequired: true,
      status: patchValues.recoveryNotificationStatus,
      reason: "sanity_mirror_pending_after_email",
      errors: [...errors, "sanity_mirror_pending_after_email"],
    };
  }

  return {
    ok: allSent,
    bookingId: recoveryBooking._id,
    notificationRequired: !allSent,
    status: patchValues.recoveryNotificationStatus,
    errors,
  };
};
