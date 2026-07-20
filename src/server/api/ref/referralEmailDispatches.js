import crypto from "node:crypto";
import { Resend } from "resend";
import { buildReferralVerificationEmailHtml } from "../../email/referralVerificationEmail.js";
import { buildResetEmailHtml } from "../../email/referralResetEmail.js";
import { createSupabaseAdminClient } from "../../supabase/adminClient.js";
import { getSafeErrorCode, logSafeError } from "../../safeErrorLog.js";

const DISPATCH_KINDS = new Set([
  "registration_verification",
  "password_reset",
]);

const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");

const SOURCE_STATE_RECOVERY_REASONS = new Set([
  "source_document_missing",
  "source_recipient_changed",
  "source_registration_not_pending",
  "source_registration_pending",
  "source_token_changed",
  "source_expiry_missing",
  "source_expiry_invalid",
  "source_expiry_changed",
  "source_dispatch_kind_invalid",
  "link_expired",
]);

export const isReferralEmailSourceStateConflict = (value) =>
  value?.referralEmailSourceStateConflict === true ||
  value?.sourceStateChanged === true ||
  value?.source_state_changed === true ||
  SOURCE_STATE_RECOVERY_REASONS.has(
    String(value?.recovery_blocked_reason || "")
  );

const requireRpcData = ({ data, error }, operation) => {
  if (!error) return data;
  const failure = new Error(`Supabase ${operation} failed.`);
  failure.code = error.code || "REFERRAL_EMAIL_DISPATCH_FAILED";
  failure.status = error.status || 503;
  failure.statusCode = failure.status;
  failure.referralEmailSourceStateConflict =
    String(error.code || "") === "40001";
  throw failure;
};

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const normalizeDispatchKind = (value) => {
  const kind = String(value || "").trim().toLowerCase();
  if (!DISPATCH_KINDS.has(kind)) {
    throw new Error("Unsupported referral email dispatch kind.");
  }
  return kind;
};

const createResendClient = (env = process.env) => {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  return apiKey ? new Resend(apiKey) : null;
};

const resolveBaseUrl = (env = process.env) =>
  String(
    env.NEXT_PUBLIC_BASE_URL ||
      env.SITE_URL ||
      "https://www.rooindustries.com"
  )
    .trim()
    .replace(/\/+$/, "");

const resolveFromAddress = (env = process.env) =>
  String(env.FROM_EMAIL || "onboarding@resend.dev").trim();

export const buildReferralEmailIdempotencyKey = ({
  dispatchKind,
  referralId,
  recipientEmail,
  token,
} = {}) => {
  const kind = normalizeDispatchKind(dispatchKind);
  const recipientHash = sha256(normalizeEmail(recipientEmail));
  const tokenHash = sha256(token);
  return `referral-email-${sha256(
    `${kind}:${String(referralId || "").trim()}:${tokenHash}:${recipientHash}`
  )}`;
};

export const enqueueReferralEmailMutation = async ({
  mutations,
  referralId,
  dispatchKind,
  recipientEmail,
  token,
  name = "",
  expiresAt,
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const email = normalizeEmail(recipientEmail);
  const kind = normalizeDispatchKind(dispatchKind);
  const result = requireRpcData(
    await adminClient.rpc("roo_enqueue_referral_email_mutation", {
      p_mutations: mutations,
      p_referral_id: String(referralId || "").trim(),
      p_dispatch_kind: kind,
      p_recipient_email: email,
      p_recipient_hash: sha256(email),
      p_token_hash: sha256(token),
      p_delivery_payload: {
        token: String(token || ""),
        name: String(name || "").slice(0, 200),
      },
      p_expires_at: String(expiresAt || ""),
    }),
    "referral email enqueue"
  );
  return result || null;
};

export const requeueReferralEmailDispatch = async ({
  referralId,
  dispatchKind,
  adminClient = createSupabaseAdminClient(),
} = {}) =>
  requireRpcData(
    await adminClient.rpc("roo_requeue_referral_email_dispatch", {
      p_referral_id: String(referralId || "").trim(),
      p_dispatch_kind: normalizeDispatchKind(dispatchKind),
    }),
    "referral email recovery"
  ) || null;

const renderDispatch = ({ dispatch, env = process.env }) => {
  const kind = normalizeDispatchKind(dispatch?.dispatch_kind);
  const token = String(dispatch?.delivery_payload?.token || "");
  const name = String(dispatch?.delivery_payload?.name || "").slice(0, 200);
  if (!token) throw new Error("Referral email delivery token is missing.");
  const baseUrl = resolveBaseUrl(env);
  if (kind === "registration_verification") {
    return {
      subject: "Confirm your Roo Industries creator account",
      html: buildReferralVerificationEmailHtml({
        name,
        verifyLink: `${baseUrl}/referrals/verify#token=${token}`,
      }),
    };
  }
  return {
    subject: "Reset your Roo Industries password",
    html: buildResetEmailHtml({
      name,
      resetLink: `${baseUrl}/referrals/reset#token=${token}`,
    }),
  };
};

const retryDelaySeconds = (attemptCount) =>
  Math.min(3600, Math.max(30, 30 * 2 ** Math.min(6, Number(attemptCount) || 1)));

const withDeadline = async (operation, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Referral email provider timed out.");
          error.code = "email_provider_timeout";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const completeDispatch = async ({
  adminClient,
  dispatch,
  leaseId,
  success,
  providerMessageId = "",
  errorCode = "",
}) =>
  requireRpcData(
    await adminClient.rpc("roo_complete_referral_email_dispatch", {
      p_idempotency_key: dispatch.idempotency_key,
      p_lease_id: leaseId,
      p_success: success,
      p_provider_message_id: providerMessageId || null,
      p_error_code: errorCode || null,
      p_retry_delay_seconds: retryDelaySeconds(dispatch.attempt_count),
    }),
    "referral email completion"
  );

const sendClaimedDispatch = async ({
  dispatch,
  leaseId,
  adminClient,
  resendClient,
  env,
}) => {
  try {
    if (!resendClient) {
      const error = new Error("Referral email provider is not configured.");
      error.code = "email_provider_unconfigured";
      throw error;
    }
    const rendered = renderDispatch({ dispatch, env });
    const result = await withDeadline(
      resendClient.emails.send(
        {
          from: resolveFromAddress(env),
          to: [normalizeEmail(dispatch.recipient_email)],
          ...rendered,
        },
        { idempotencyKey: dispatch.idempotency_key }
      ),
      20_000
    );
    if (result?.error) throw result.error;
    await completeDispatch({
      adminClient,
      dispatch,
      leaseId,
      success: true,
      providerMessageId: String(result?.data?.id || "").slice(0, 256),
    });
    return { sent: 1, retry: 0, deadLetter: 0 };
  } catch (error) {
    logSafeError("Referral email delivery failed", error);
    const completion = await completeDispatch({
      adminClient,
      dispatch,
      leaseId,
      success: false,
      errorCode: getSafeErrorCode(error, "email_send_failed"),
    });
    return {
      sent: 0,
      retry: completion?.status === "retry" ? 1 : 0,
      deadLetter: completion?.status === "dead_letter" ? 1 : 0,
    };
  }
};

export const deliverReferralEmailDispatch = async ({
  idempotencyKey,
  adminClient = createSupabaseAdminClient(),
  resendClient = createResendClient(),
  env = process.env,
} = {}) => {
  const leaseId = crypto.randomUUID();
  const dispatch = requireRpcData(
    await adminClient.rpc("roo_claim_referral_email_dispatch", {
      p_idempotency_key: String(idempotencyKey || "").trim(),
      p_lease_id: leaseId,
      p_lease_seconds: 120,
    }),
    "referral email claim"
  );
  if (!dispatch?.claimed) {
    return {
      claimed: false,
      sent: dispatch?.sent === true ? 1 : 0,
      pending: dispatch?.in_progress === true,
      deadLetter: dispatch?.dead_letter === true ? 1 : 0,
      sourceStateChanged: dispatch?.source_state_changed === true,
    };
  }
  const summary = await sendClaimedDispatch({
    dispatch,
    leaseId,
    adminClient,
    resendClient,
    env,
  });
  return {
    claimed: true,
    ...summary,
    pending: summary.retry > 0,
  };
};

export const reconcileReferralEmailDispatches = async ({
  limit = 10,
  adminClient = createSupabaseAdminClient(),
  resendClient = createResendClient(),
  env = process.env,
} = {}) => {
  const leaseId = crypto.randomUUID();
  const dispatches = requireRpcData(
    await adminClient.rpc("roo_claim_referral_email_dispatches", {
      p_lease_id: leaseId,
      p_limit: Math.max(1, Math.min(10, Number(limit) || 10)),
      p_lease_seconds: 300,
    }),
    "referral email batch claim"
  );
  const summary = {
    claimed: Array.isArray(dispatches) ? dispatches.length : 0,
    sent: 0,
    retry: 0,
    deadLetter: 0,
  };
  for (const dispatch of Array.isArray(dispatches) ? dispatches : []) {
    try {
      const result = await sendClaimedDispatch({
        dispatch,
        leaseId,
        adminClient,
        resendClient,
        env,
      });
      summary.sent += result.sent;
      summary.retry += result.retry;
      summary.deadLetter += result.deadLetter;
    } catch (error) {
      logSafeError("Referral email dispatch checkpoint failed", error);
      summary.retry += 1;
    }
  }
  return summary;
};

export const sendReferralEmailDirect = async ({
  dispatchKind,
  referralId,
  recipientEmail,
  token,
  name = "",
  resendClient = createResendClient(),
  env = process.env,
} = {}) => {
  if (!resendClient) throw new Error("Referral email provider is not configured.");
  const idempotencyKey = buildReferralEmailIdempotencyKey({
    dispatchKind,
    referralId,
    recipientEmail,
    token,
  });
  const rendered = renderDispatch({
    dispatch: {
      dispatch_kind: dispatchKind,
      delivery_payload: { token, name },
    },
    env,
  });
  const result = await resendClient.emails.send(
    {
      from: resolveFromAddress(env),
      to: [normalizeEmail(recipientEmail)],
      ...rendered,
    },
    { idempotencyKey }
  );
  if (result?.error) throw result.error;
  return { idempotencyKey, providerMessageId: String(result?.data?.id || "") };
};
