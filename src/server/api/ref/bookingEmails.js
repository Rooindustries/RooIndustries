import { createDataClient as createClient } from "../../data/documentClient.js";
import { Resend } from "resend";
import crypto from "crypto";
import { getSafeErrorCode, logSafeError } from "../../safeErrorLog.js";
import { formatAppointmentTime } from "../../email/appointmentTime.js";
import { isIdempotencyPayloadConflict } from "../../email/resendOutcome.js";
import { isBookingBlockingStatus } from "../../booking/bookingStatus.js";
import {
  claimEmailDispatchPair,
  completeEmailDispatch,
  listEmailDispatchRecoveryBookingIds,
} from "../../supabase/emailDispatchLedger.js";

const writeClient = createClient({}, { domain: "commerce" });

const DELIVERY_UNKNOWN_REASONS = new Set([
  "email_delivery_unknown", "historical_delivery_unknown", "delivery_unknown", "historical_unknown",
]);

export const isEmailDeliveryUnknown = (outcome = {}) =>
  outcome.deliveryUnknown === true || DELIVERY_UNKNOWN_REASONS.has(outcome.status) ||
  [outcome.ledger?.customer, outcome.ledger?.owner].some(recipient =>
    recipient?.historicalUnknown === true && recipient.sent !== true) ||
  [outcome.client?.skippedReason, outcome.owner?.skippedReason,
    outcome.emailDispatch?.client?.skippedReason, outcome.emailDispatch?.owner?.skippedReason,
    ...(Array.isArray(outcome.errors) ? outcome.errors : [])].some(reason => DELIVERY_UNKNOWN_REASONS.has(reason));

export const isBookingEmailSuppressed = (outcome = {}) =>
  outcome?.code === "booking_inactive" || outcome?.suppressed === true || outcome?.emailDispatch?.suppressed === true ||
  [outcome?.client?.skippedReason, outcome?.owner?.skippedReason,
    outcome?.emailDispatch?.client?.skippedReason, outcome?.emailDispatch?.owner?.skippedReason].includes("booking_inactive");

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

const sendEmailAtLease = async ({ client, booking, leaseId, recovery = false, recipient, previouslySuppressed = false }, message, options) => {
  const prefix = recovery ? "recoveryNotification" : "emailDispatch";
  const recipientPrefix = recovery ? `recovery${recipient}` : `emailDispatch${recipient}`;
  const firstAttemptField = `${recipientPrefix}FirstAttemptAt`;
  const current = await client.fetch(`*[_type == "booking" && _id == $id][0]{...}`, { id: booking._id });
  const leaseExpiresAt = new Date(current?.[`${prefix}LeaseExpiresAt`] || "").getTime();
  if (!current?._rev || current?.[`${prefix}LeaseId`] !== leaseId ||
      !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.now()) {
    throw Object.assign(new Error("Email dispatch lease changed."), { code: "email_dispatch_lease_changed", status: 409 });
  }
  if (!recovery && !isBookingBlockingStatus(current.status)) {
    return { data: null, error: { code: "booking_inactive" } };
  }
  const firstAttemptAt = current[firstAttemptField] ||
    (Number(booking[`${prefix}AttemptCount`] || 0) > 0 &&
      (recovery || (!previouslySuppressed && booking.emailDispatchLastError !== "booking_inactive"))
      ? booking[`${prefix}LastAttemptAt`] || "unknown"
      : new Date().toISOString());
  const age = Date.now() - new Date(firstAttemptAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60 * 1000) {
    logSafeError("Booking email requires delivery review", { code: "email_delivery_unknown", status: 409 });
    return { data: null, error: { code: "email_delivery_unknown" } };
  }
  let attemptPatch = client.patch(current._id).ifRevisionId(current._rev).set({ [firstAttemptField]: firstAttemptAt });
  if (!recovery) {
    attemptPatch = attemptPatch.set({ emailDispatchLastAttemptAt: new Date().toISOString() });
    if (Number(current.emailDispatchAttemptCount || 0) <= Number(booking.emailDispatchAttemptCount || 0)) {
      attemptPatch = attemptPatch.setIfMissing({ emailDispatchAttemptCount: 0 }).inc({ emailDispatchAttemptCount: 1 });
    }
  }
  await attemptPatch.commit();
  const result = await resend.emails.send(message, options);
  if (isIdempotencyPayloadConflict(result)) {
    logSafeError("Booking email requires delivery review", { code: "email_delivery_unknown", status: 409 });
    return { data: null, error: { code: "email_delivery_unknown" } };
  }
  if (!result.error && !String(result.data?.id || "").trim()) {
    return { data: null, error: { code: "email_provider_receipt_missing" } };
  }
  return result;
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
  <div style="margin:0;padding:0;background:#e9edf3;font-family:Arial,Helvetica,sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(intro)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#e9edf3;padding:32px 12px">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#0f172a;border:1px solid #2a3f5c;border-radius:16px;overflow:hidden;table-layout:fixed">
            <tr>
              <td style="padding:26px 28px 18px;text-align:center;background:#0b1120">
                <img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(siteName)}" height="44" style="height:44px;display:block;margin:0 auto 8px"/>
                <div style="font-weight:700;font-size:16px;color:#7dd3fc;letter-spacing:.4px">${escapeHtml(siteName)}</div>
              </td>
            </tr>
            <tr><td style="height:2px;background:#0ea5e9;font-size:0;line-height:0">&nbsp;</td></tr>
            <tr>
              <td style="padding:28px">
                <h1 style="margin:0 0 10px;font-size:21px;line-height:1.3;color:#a5e8ff">${escapeHtml(heading)}</h1>
                <p style="margin:0 0 18px;font-size:14px;line-height:1.65;color:#cbd5e1">${escapeHtml(intro)}</p>
                ${
                  discordInviteUrl
                    ? `<p style="margin:0 0 22px">
                <a href="${escapeHtml(discordInviteUrl)}" target="_blank" rel="noopener noreferrer"
                   style="display:inline-block;padding:11px 20px;border-radius:8px;background:#38bdf8;color:#0b1120;font-size:14px;font-weight:700;text-decoration:none">
                  ${escapeHtml(
                    discordLabel || "Join the Roo Industries Discord (Required)"
                  )}
                </a>
              </p>`
                    : ""
                }
                <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#0b1120;border:1px solid #24405e;border-radius:10px;table-layout:fixed">
                  <tbody>
                    ${fields
                      .map(
                        (field, index) => `
                      <tr>
                        <td style="padding:11px 16px;font-size:13px;color:#93c5fd;overflow-wrap:anywhere;word-break:break-word${index === 0 ? ";width:40%" : ""}${index === fields.length - 1 ? "" : ";border-bottom:1px solid #16263d"}">${escapeHtml(field.label)}</td>
                        <td style="padding:11px 16px;font-size:13px;font-weight:600;color:#e5f2ff;overflow-wrap:anywhere;word-break:break-word${index === fields.length - 1 ? "" : ";border-bottom:1px solid #16263d"}">${escapeHtml(field.value)}</td>
                      </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
                <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#64748b">This is an automatic email from ${escapeHtml(siteName)}.</p>
              </td>
            </tr>
          </table>
          <div style="max-width:640px;margin:14px auto 0;font-size:11px;color:#8494ab;text-align:center">
            Roo Industries · Precision Performance Engineering
          </div>
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

const formatMoney = (value, currency = "USD") => {
  if (value == null || String(value).trim() === "" || !Number.isFinite(Number(value))) return "-";
  const options = { style: "currency", currency: String(currency || "USD").trim(), useGrouping: false };
  try {
    return new Intl.NumberFormat("en-US", options).format(Number(value));
  } catch {
    return `${Number(value).toFixed(2)} (currency unavailable)`;
  }
};

export const formatRequestedTimeFields = (booking = {}) => {
  const appointment = formatAppointmentTime(
    booking.originalRequestedStartTimeUTC,
    booking.localTimeZone
  );
  if (!appointment) {
    return [{ label: "Time Selected", value: "Unavailable" }];
  }
  return [
    { label: "Requested Date", value: appointment.date },
    { label: "Requested Time", value: appointment.time },
    { label: "Time Zone", value: appointment.timeZone },
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
      status,
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
      currency,
      couponCode,
      couponDiscountPercent,
      couponDiscountAmount,
      couponDiscountType,
      couponDiscountValue,
      hostDate,
      hostTime,
      hostTimeZone,
      startTimeUTC,
      localTimeZone,
      displayDate,
      displayTime,
      emailDispatchDeferred,
      emailDispatchStatus,
      emailDispatchQueuedAt,
      emailDispatchLastAttemptAt,
      emailDispatchClientFirstAttemptAt,
      emailDispatchOwnerFirstAttemptAt,
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

const buildBookingFieldGroups = (booking = {}) => {
  const siteName = process.env.SITE_NAME || "Roo Industries";
  const logoUrl = resolveLogoUrl();
  const appointment = formatAppointmentTime(booking.startTimeUTC, booking.localTimeZone);
  const hostAppointment = formatAppointmentTime(booking.startTimeUTC, OWNER_TZ_NAME);
  const hasNetAmount = ["number", "string"].includes(typeof booking.netAmount) &&
    String(booking.netAmount).trim() !== "" && Number.isFinite(Number(booking.netAmount));
  const currency = booking.currency || "USD";
  const priceAmount = hasNetAmount ? booking.netAmount : booking.grossAmount;
  const priceDisplay = formatMoney(priceAmount, currency);
  const discountPercentValue = Number(booking.discountPercent || 0);
  const discountAmountValue = Number(booking.discountAmount || 0);
  const couponPercentValue = Number(booking.couponDiscountPercent || 0);
  const couponAmountValue = Number(booking.couponDiscountAmount || 0);
  const couponType = String(booking.couponDiscountType || "").trim().toLowerCase();
  const couponValue = Number(booking.couponDiscountValue || 0);
  const couponSuffix =
    hasNetAmount && (couponPercentValue > 0 || couponAmountValue > 0)
      ? couponType === "fixed"
        ? ` (${formatMoney(couponValue || couponAmountValue, currency)} off - ${formatMoney(couponAmountValue, currency)})`
        : ` (${couponPercentValue}% - ${formatMoney(couponAmountValue, currency)})`
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
        hasNetAmount && Number(booking.netAmount) < Number(booking.grossAmount || 0)
          ? `${formatMoney(booking.netAmount, currency)} (was ${formatMoney(booking.grossAmount, currency)})`
          : priceDisplay !== "-" ? priceDisplay : booking.packagePrice || "-",
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
  if (hasNetAmount && (discountPercentValue > 0 || discountAmountValue > 0)) {
    ownerDiscountFields.push({
      label: "Discount",
      value: `${discountPercentValue}% (${formatMoney(discountAmountValue, currency)})`,
    });
  }

  const clientFields = [
    { label: "Date", value: appointment?.date || "Unavailable" },
    { label: "Time", value: appointment?.time || "Unavailable" },
    { label: "Time Zone", value: appointment?.timeZone || "Unavailable" },
    ...sharedCoreFields,
  ];

  const ownerFields = [
    { label: "Client Date", value: appointment?.date || "Unavailable" },
    { label: "Client Time", value: appointment?.time || "Unavailable" },
    { label: "Client Time Zone", value: appointment?.timeZone || "Unavailable" },
    { label: "Date", value: hostAppointment?.shortDate || "Unavailable" },
    { label: "Time", value: hostAppointment?.time || "Unavailable" },
    { label: "Time Zone", value: hostAppointment?.timeZone || "Unavailable" },
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
    ownerScheduleLabel: hostAppointment
      ? `${hostAppointment.shortDate} ${hostAppointment.time}`
      : "Unavailable",
  };
};

const suppressBookingConfirmation = async ({ client, booking }) => {
  const leaseId = crypto.randomUUID();
  const recipientTypes = booking.emailDispatchLastError === "booking_inactive"
    ? [["customer", "Client"], ["owner", "Owner"]].filter(([, name]) =>
      !booking[`emailDispatch${name}SentAt`] && booking[`emailDispatch${name}ProviderId`]).map(([type]) => type)
    : ["customer", "owner"];
  const ledger = await claimEmailDispatchPair({ client, bookingId: booking._id,
    dispatchKind: "booking_confirmation", leaseId, recipientTypes });
  const dispatch = buildEmailDispatchState();
  dispatch.deliveryEnabled = hasEmailDeliveryConfig();
  for (const [name, entry, sentAt] of [
    ["client", ledger?.customer, booking.emailDispatchClientSentAt],
    ["owner", ledger?.owner, booking.emailDispatchOwnerSentAt],
  ]) {
    dispatch[name].sent = !!sentAt || entry?.sent === true;
    dispatch[name].skippedReason = dispatch[name].sent ? "already_sent"
      : entry?.historicalUnknown ? "historical_delivery_unknown" : "booking_inactive";
    if (entry?.claimed) {
      await recordEmailLedgerOutcome({ client, dispatch: entry, leaseId, success: false, errorCode: "booking_inactive" });
    }
  }
  dispatch.allSent = false;
  const deliveryUnknown = isEmailDeliveryUnknown({ ...dispatch, ledger });
  dispatch.suppressed = !deliveryUnknown;
  const current = await getBookingForEmailDispatch({ client, bookingId: booking._id });
  if (current?._rev && !isBookingBlockingStatus(current.status)) {
    const receipts = {};
    for (const [name, entry] of [["Client", ledger?.customer], ["Owner", ledger?.owner]]) {
      if (entry?.sent && !current[`emailDispatch${name}SentAt`] && entry.sentAt) {
        receipts[`emailDispatch${name}SentAt`] = entry.sentAt;
        if (entry.providerMessageId) receipts[`emailDispatch${name}ProviderId`] = entry.providerMessageId;
      }
    }
    const values = {
      ...receipts,
      emailDispatchStatus: deliveryUnknown ? "delivery_unknown"
        : dispatch.client.sent && dispatch.owner.sent ? "sent"
          : dispatch.client.sent || dispatch.owner.sent ? "partial" : "failed",
      emailDispatchLastError: deliveryUnknown ? "email_delivery_unknown" : "booking_inactive",
      emailDispatchDeferred: false, emailDispatchNextAttemptAt: "",
      emailDispatchLeaseId: "", emailDispatchLeaseExpiresAt: "",
    };
    if (Object.entries(values).some(([key, value]) => current[key] !== value)) {
      await client.patch(current._id).ifRevisionId(current._rev).set(values).commit();
    }
  }
  return { httpStatus: deliveryUnknown ? 503 : 409, body: {
    ok: false, bookingId: booking._id, retryable: false, deliveryUnknown,
    ...(deliveryUnknown ? {} : { code: "booking_inactive" }), emailDispatch: dispatch,
  } };
};

export const sendBookingEmailsForBooking = async ({ bookingId, client = writeClient }) => {
  const resolvedBooking = await getBookingForEmailDispatch({ bookingId, client });

  if (!resolvedBooking?._id) {
    return {
      httpStatus: 404,
      body: {
        ok: false,
        error: "Booking not found.",
      },
    };
  }

  if (!resolvedBooking._rev) {
    logSafeError("Booking email source revision missing", { code: "email_revision_missing", status: 409 });
    return { httpStatus: 409, body: { ok: false, retryable: false, error: "Booking source revision is missing." } };
  }

  if (isEmailDeliveryUnknown({ status: resolvedBooking.emailDispatchStatus }) &&
      !(resolvedBooking.emailDispatchClientSentAt && resolvedBooking.emailDispatchOwnerSentAt)) {
    if (resolvedBooking.emailDispatchNextAttemptAt || resolvedBooking.emailDispatchLeaseId ||
        resolvedBooking.emailDispatchLeaseExpiresAt || resolvedBooking.emailDispatchStatus !== "delivery_unknown") {
      await client.patch(resolvedBooking._id).ifRevisionId(resolvedBooking._rev).set({
        emailDispatchStatus: "delivery_unknown", emailDispatchNextAttemptAt: "",
        emailDispatchLeaseId: "", emailDispatchLeaseExpiresAt: "",
      }).commit();
    }
    const dispatch = buildDeferredEmailDispatch({ booking: resolvedBooking });
    if (!dispatch.client.sent) dispatch.client.skippedReason = "historical_delivery_unknown";
    if (!dispatch.owner.sent) dispatch.owner.skippedReason = "historical_delivery_unknown";
    return { httpStatus: 503, body: { ok: false, bookingId: resolvedBooking._id,
      retryable: false, deliveryUnknown: true, emailDispatch: dispatch } };
  }

  if (!isBookingBlockingStatus(resolvedBooking.status)) {
    return suppressBookingConfirmation({ client, booking: resolvedBooking });
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
      })
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
    emailDispatchLastError: "",
  };

  const owner = await resolveBookingOwnerEmail(client);
  const { siteName, logoUrl, bookingRef, clientFields, ownerFields, ownerScheduleLabel } =
    buildBookingFieldGroups(resolvedBooking);
  const from = process.env.FROM_EMAIL;
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
      : ledger?.customer?.inactive ? "booking_inactive"
        : ledger?.customer?.historicalUnknown ? "historical_delivery_unknown" : "delivery_disabled";
    dispatch.owner.skippedReason = ownerAlreadySent
      ? "already_sent"
      : ledger?.owner?.inactive ? "booking_inactive"
        : ledger?.owner?.historicalUnknown ? "historical_delivery_unknown" : "delivery_disabled";
    dispatch.allSent = dispatch.client.sent && dispatch.owner.sent;
    const deliveryUnknown = isEmailDeliveryUnknown({ ...dispatch, ledger });
    const bookingInactive = dispatch.client.skippedReason === "booking_inactive" || dispatch.owner.skippedReason === "booking_inactive";
    patchValues.emailDispatchStatus = deliveryUnknown ? "delivery_unknown" : dispatch.allSent ? "sent" : bookingInactive ? "failed" : "delivery_disabled";
    if (bookingInactive) patchValues.emailDispatchLastError = "booking_inactive";
    patchValues.emailDispatchDeferred = false;
    patchValues.emailDispatchLeaseId = "";
    patchValues.emailDispatchLeaseExpiresAt = "";
    patchValues.emailDispatchNextAttemptAt = dispatch.allSent || deliveryUnknown || bookingInactive
      ? ""
      : new Date(nowMs + 5 * 60 * 1000).toISOString();
    await client.patch(resolvedBooking._id).set(patchValues).commit();
    return {
      httpStatus: dispatch.allSent ? 200 : bookingInactive ? 409 : 503,
      body: {
        ok: dispatch.allSent,
        bookingId: resolvedBooking._id,
        retryable: !dispatch.allSent && !deliveryUnknown && !bookingInactive,
        ...(bookingInactive ? { code: "booking_inactive" } : {}),
        deliveryUnknown,
        emailDispatch: dispatch,
      },
    };
  }

  if (clientAlreadySent) {
    dispatch.client.sent = true;
    dispatch.client.skippedReason = "already_sent";
  } else if (ledger?.customer?.historicalUnknown) {
    dispatch.client.skippedReason = "historical_delivery_unknown";
  } else if (ledger?.customer?.inactive) {
    dispatch.client.skippedReason = "booking_inactive";
  } else if (ledger && !ledger.customer?.claimed) {
    dispatch.client.skippedReason = "dispatch_in_progress";
  } else if (!clientRecipient) {
    dispatch.client.skippedReason = "missing_client_recipient";
  } else {
    dispatch.client.attempted = true;
    try {
      const { data, error } = await sendEmailAtLease(
        { client, booking: resolvedBooking, leaseId, recipient: "Client", previouslySuppressed: ledger?.customer?.previouslySuppressed },
        {
          from,
          to: clientRecipient,
          subject: `Your ${siteName} booking`,
          html: emailHtml({
            logoUrl,
            siteName,
            heading: "Booking Received",
            intro:
              "To continue with your booking, please join the Roo Industries Discord using the button below. I'll contact you there (or by email if needed) to confirm your time and details.",
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
        if (errorCode === "booking_inactive") dispatch.client.attempted = false;
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
  } else if (ledger?.owner?.inactive) {
    dispatch.owner.skippedReason = "booking_inactive";
  } else if (ledger && !ledger.owner?.claimed) {
    dispatch.owner.skippedReason = "dispatch_in_progress";
  } else if (!owner) {
    dispatch.owner.skippedReason = "missing_owner_recipient";
  } else {
    dispatch.owner.attempted = true;
    try {
      const { data, error } = await sendEmailAtLease(
        { client, booking: resolvedBooking, leaseId, recipient: "Owner", previouslySuppressed: ledger?.owner?.previouslySuppressed },
        {
          from,
          to: owner,
          subject: `New booking ${bookingRef} - ${String(resolvedBooking.packageTitle || "").trim() || "Unknown package"} (${ownerScheduleLabel})`,
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
        if (errorCode === "booking_inactive") dispatch.owner.attempted = false;
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
  const deliveryUnknown = isEmailDeliveryUnknown({ ...dispatch, ledger });
  const bookingInactive = dispatch.client.skippedReason === "booking_inactive" || dispatch.owner.skippedReason === "booking_inactive";

  patchValues.emailDispatchStatus = deliveryUnknown ? "delivery_unknown" : dispatch.allSent
    ? "sent"
    : dispatch.client.sent || dispatch.owner.sent
      ? "partial"
      : "failed";
  patchValues.emailDispatchDeferred = false;
  patchValues.emailDispatchLastError = bookingInactive ? "booking_inactive" : lastErrors;
  patchValues.emailDispatchLeaseId = "";
  patchValues.emailDispatchLeaseExpiresAt = "";
  patchValues.emailDispatchNextAttemptAt = dispatch.allSent || deliveryUnknown || bookingInactive
    ? ""
    : new Date(nowMs + 5 * 60 * 1000).toISOString();

  const latestBooking = await getBookingForEmailDispatch({
    bookingId: resolvedBooking._id,
    client,
  });
  if (!latestBooking?._id) {
    return { httpStatus: 404, body: { ok: false, error: "Booking not found." } };
  }
  if (!isBookingBlockingStatus(latestBooking.status)) {
    return suppressBookingConfirmation({ client, booking: latestBooking });
  }
  if (!latestBooking?.emailDispatchLeaseId || latestBooking.emailDispatchLeaseId === leaseId) {
    let completionPatch = client.patch(resolvedBooking._id);
    if (latestBooking?._rev && typeof completionPatch.ifRevisionId === "function") {
      completionPatch = completionPatch.ifRevisionId(latestBooking._rev);
    }
    await completionPatch.set(patchValues).commit();
  }

  return {
    httpStatus: dispatch.allSent ? 200 : bookingInactive ? 409 : 503,
    body: {
      ok: dispatch.allSent,
      bookingId: resolvedBooking._id,
      retryable: !dispatch.allSent && !deliveryUnknown && !bookingInactive,
      ...(bookingInactive ? { code: "booking_inactive" } : {}),
      deliveryUnknown,
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
    limit: 100,
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
  const eligible = ordered.filter(booking =>
    isBookingBlockingStatus(booking.status) || booking.emailDispatchLastError !== "booking_inactive" ||
    ["Client", "Owner"].some(name => !booking[`emailDispatch${name}SentAt`] && booking[`emailDispatch${name}ProviderId`]));
  if (ledgerBookingIds?.length === 100 && eligible.length < Math.min(20, Number(limit) || 20)) {
    const additional = await client.fetch(`*[_type == "booking"
      && emailDispatchStatus in ["partial", "failed", "retry"]
      && emailDispatchLastError != "booking_inactive"
      && (!defined(emailDispatchNextAttemptAt) || emailDispatchNextAttemptAt == "" || emailDispatchNextAttemptAt <= $now)
      && (!defined(emailDispatchClientSentAt) || !defined(emailDispatchOwnerSentAt))
    ] | order(emailDispatchNextAttemptAt asc, _updatedAt asc)[0...20]{...}`, { now });
    for (const booking of additional || []) {
      if (!byId.has(booking._id)) eligible.push(booking);
    }
  }
  const selected = eligible.slice(0, Math.max(1, Math.min(20, Number(limit) || 20)));
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

  if (!recoveryBooking._rev) {
    logSafeError("Booking email source revision missing", { code: "email_revision_missing", status: 409 });
    return { ok: false, notificationRequired: true, reason: "email_revision_missing" };
  }

  if (isEmailDeliveryUnknown({ status: recoveryBooking.recoveryNotificationStatus })) {
    if (recoveryBooking.recoveryNotificationNextAttemptAt || recoveryBooking.recoveryNotificationLeaseId ||
        recoveryBooking.recoveryNotificationLeaseExpiresAt || recoveryBooking.recoveryNotificationStatus !== "delivery_unknown") {
      await client.patch(recoveryBooking._id).ifRevisionId(recoveryBooking._rev).set({
        recoveryNotificationStatus: "delivery_unknown", recoveryNotificationNextAttemptAt: "",
        recoveryNotificationLeaseId: "", recoveryNotificationLeaseExpiresAt: "",
      }).commit();
    }
    return { ok: false, bookingId: recoveryBooking._id, notificationRequired: false,
      status: "delivery_unknown", retryable: false, deliveryUnknown: true,
      errors: ["historical_delivery_unknown"] };
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
    recoveryBooking.dodoTotalAmount ?? recoveryBooking.netAmount ?? recoveryBooking.grossAmount,
    recoveryBooking.currency
  );
  const fields = [
    { label: "Order ID", value: recoveryBooking._id },
    { label: "Package", value: recoveryBooking.packageTitle || "-" },
    { label: "Paid Amount", value: amount },
    ...formatRequestedTimeFields(recoveryBooking),
  ];
  const hostAppointment = formatAppointmentTime(
    recoveryBooking.originalRequestedStartTimeUTC,
    OWNER_TZ_NAME
  );
  const ownerScheduleLabel = hostAppointment
    ? `${hostAppointment.shortDate} ${hostAppointment.time}`
    : "Unavailable";
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
        const { data, error } = await sendEmailAtLease(
          { client, booking: recoveryBooking, leaseId, recovery: true, recipient: "Client" },
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
        const { data, error } = await sendEmailAtLease(
          { client, booking: recoveryBooking, leaseId, recovery: true, recipient: "Owner" },
          {
            from,
            to: owner,
            subject: `Paid booking requires reschedule - ${recoveryBooking._id} (${ownerScheduleLabel})`,
            html: emailHtml({
              logoUrl: resolveLogoUrl(),
              siteName,
              heading: "Captured payment requires manual rescheduling",
              intro:
                "The payment was captured, but the original booking slot could not be reconstructed or is no longer available. Contact the customer and assign a new time.",
              fields: [
                ...fields,
                { label: "Host Date", value: hostAppointment?.shortDate || "Unavailable" },
                { label: "Host Time", value: hostAppointment?.time || "Unavailable" },
                { label: "Host Time Zone", value: hostAppointment?.timeZone || "Unavailable" },
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
  const deliveryUnknown = isEmailDeliveryUnknown({ errors, ledger: recoveryLedger });
  patchValues.recoveryNotificationStatus = deliveryUnknown ? "delivery_unknown" : allSent
    ? "sent"
    : clientSent || ownerSent
      ? "partial"
      : "pending";
  patchValues.recoveryNotificationLastError = errors.join(" | ");
  patchValues.recoveryNotificationNextAttemptAt = allSent || deliveryUnknown
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

  return {
    ok: allSent,
    bookingId: recoveryBooking._id,
    notificationRequired: !allSent && !deliveryUnknown,
    retryable: !allSent && !deliveryUnknown,
    deliveryUnknown,
    status: patchValues.recoveryNotificationStatus,
    errors,
  };
};
