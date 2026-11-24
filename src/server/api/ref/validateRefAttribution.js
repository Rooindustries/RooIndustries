import { isKnownAdRefTag } from "../../../lib/refShape.js";
import { chooseFirstTouchRef, parseRefCookieHeader, sanitizeRefEntry } from "../../../lib/refEntry.js";
import { sanitizeSalesAttribution } from "../../../lib/salesAttribution.ts";
export const REF_LOOKUP_TIMEOUT_MS = 1500;
const CREATOR_REF_QUERY =
  `*[_type == "referral" && registrationStatus != "pending_email" && lower(slug.current) == $code][0]{_id}`;
const CONFLICT_ERROR_CODES = [
  "payment_currency_mismatch", "upgrade_credit_changed_after_quote", "upgrade_credit_unverified",
];
export const isAllowedRefSource = async ({
  source, client = null, lookupCreator = null, timeoutMs = REF_LOOKUP_TIMEOUT_MS,
} = {}) => {
  const code = String(source || "").trim().toLowerCase();
  if (!code || isKnownAdRefTag(code)) return Boolean(code);
  const lookup = typeof lookupCreator === "function"
    ? () => lookupCreator(code)
    : () => client?.fetch?.(CREATOR_REF_QUERY, { code }).then((creator) => Boolean(creator?._id));
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(lookup).then(Boolean).catch(() => false), timeout]);
  } finally { if (timer) clearTimeout(timer); }
};
export const resolveValidatedServerSalesAttribution = async ({
  salesAttribution = null, cookieHeader = "", client = null,
  lookupCreator = null, now = Date.now(), timeoutMs = REF_LOOKUP_TIMEOUT_MS,
} = {}) => {
  const sanitized = sanitizeSalesAttribution(salesAttribution, now);
  const hasBody = salesAttribution && typeof salesAttribution === "object" && !Array.isArray(salesAttribution);
  const candidate = chooseFirstTouchRef(
    [parseRefCookieHeader(cookieHeader, now), hasBody ? sanitizeRefEntry(salesAttribution.ref, now) : null], now
  );
  const allowed = candidate && await isAllowedRefSource({ source: candidate.source, client, lookupCreator, timeoutMs });
  const validRef = allowed ? candidate : null;
  if (!sanitized || typeof sanitized.journeyId !== "string") return validRef ? { ref: validRef } : undefined;
  const { ref: _ignored, ...rest } = sanitized;
  return validRef ? { ...rest, ref: validRef } : rest;
};
export const resolveReplayReferralFields = async ({
  client, referralCode = "", referralId = "", isInternalPaymentFinalization: internal = false,
} = {}) => {
  const code = !internal && isKnownAdRefTag(referralCode) ? "" : referralCode;
  const q = `*[_type == "referral" && _id == $id][0]{"code": slug.current}`;
  const doc = !internal && referralId ? await client.fetch(q, { id: referralId }) : null;
  const id = isKnownAdRefTag(doc?.code) ? "" : referralId;
  return { ...(code ? { referralCode: code } : {}), ...(id ? { referral: { _ref: id } } : {}) };
};
export const optionalAttributionField = (value) => {
  const sanitized = sanitizeSalesAttribution(value, null);
  return sanitized ? { salesAttribution: sanitized } : {};
};
export const isExposedBookingErrorCode = (status, code) =>
  (status === 400 && code === "coupon_invalid") || (status === 409 && CONFLICT_ERROR_CODES.includes(code));
export const resolveBookingAttributionField = async ({
  isInternalPaymentFinalization: internal = false, internalPaymentRecord: rec = null, req = null, client = null,
} = {}) => {
  const salesAttribution = internal ? rec?.bookingPayload?.salesAttribution : req?.body?.salesAttribution;
  const cookieHeader = internal ? "" : String(req?.headers?.cookie || "");
  const resolved = await resolveValidatedServerSalesAttribution({ salesAttribution, cookieHeader, client });
  return resolved ? { salesAttribution: resolved } : {};
};
