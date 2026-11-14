import crypto from "crypto";
import { Resend } from "resend";
import { isValidEmail } from "../../lib/emailValidation.js";
import contactEmail from "../../lib/contactEmail.js";
import { isIdempotencyPayloadConflict } from "../email/resendOutcome.js";
import { getSafeErrorCode, logSafeError } from "../safeErrorLog.js";
import { createSupabaseAdminClient } from "../supabase/adminClient.js";
import envValue from "../supabase/envValue.cjs";

const { CONTACT_EMAIL } = contactEmail;
const { readEnvValue } = envValue;

const NAME_LIMIT = 100;
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const SEND_TIMEOUT_MS = 8000;

const contactError = (code, status, extra = {}) =>
  Object.assign(new Error(code), { code, status, ...extra });

const text = (value) => (typeof value === "string" ? value.trim() : "");

const hashSecret = (env) =>
  readEnvValue(env, "RATE_LIMIT_HASH_SECRET") ||
  (env.NODE_ENV === "test" ? "test-rate-limit-secret" : "");

const contactClientHash = (clientAddress, env = process.env) => {
  const secret = hashSecret(env);
  if (!secret) throw contactError("contact_hash_unconfigured", 503);
  return crypto
    .createHmac("sha256", secret)
    .update(`contact-message:${String(clientAddress || "unknown")}`)
    .digest("hex");
};

const validate = ({ name, email, message }) => {
  const values = {
    name: text(name).replace(/\s+/g, " "),
    email: text(email),
    message: text(message),
  };
  const fields = {};
  if (!values.name || values.name.length > NAME_LIMIT || CONTROL_CHARACTERS.test(values.name)) {
    fields.name = "Enter your name, up to 100 characters.";
  }
  if (!isValidEmail(values.email)) fields.email = "Enter a valid email address.";
  if (
    values.message.length < MESSAGE_MIN ||
    values.message.length > MESSAGE_MAX ||
    CONTROL_CHARACTERS.test(values.message)
  ) {
    fields.message = "Write a message between 10 and 5,000 characters.";
  }
  if (Object.keys(fields).length) throw contactError("contact_invalid", 400, { fields });
  return values;
};

const rpcError = (operation, error) =>
  contactError(String(error?.code || `contact_${operation}_failed`), 503, {
    status: Number(error?.status) || 503,
  });

const deliveryConfig = (env) => ({
  apiKey: readEnvValue(env, "RESEND_API_KEY"),
  from: readEnvValue(env, "FROM_EMAIL"),
  to: readEnvValue(env, "OWNER_EMAIL") || CONTACT_EMAIL,
});

const sendMessage = async ({ id, name, email, message }, env) => {
  const { apiKey, from, to } = deliveryConfig(env);
  if (!apiKey || !from) return { sent: false, errorCode: "email_provider_unconfigured" };
  const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
  try {
    const result = await new Resend(apiKey).emails.send(
      {
        from,
        to: [to],
        replyTo: email,
        subject: `Contact form: ${name}`,
        text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
      },
      { idempotencyKey: `contact-message-${id}`, signal }
    );
    if (isIdempotencyPayloadConflict(result)) return { sent: false, errorCode: "email_delivery_unknown" };
    if (result?.error) {
      const code = signal.aborted ? "email_send_timeout" : result.error.name || result.error.code;
      return { sent: false, errorCode: getSafeErrorCode({ code }, "email_send_failed") };
    }
    const providerMessageId = String(result?.data?.id || "").trim();
    if (!providerMessageId) return { sent: false, errorCode: "email_provider_receipt_missing" };
    return { sent: true, providerMessageId };
  } catch (error) {
    return { sent: false, errorCode: getSafeErrorCode(error, "email_send_failed") };
  }
};

const deliver = async (row, adminClient, env) => {
  const outcome = await sendMessage(row, env);
  if (!outcome.sent) {
    logSafeError("contact_message_send_failed", { code: outcome.errorCode, status: 502 });
  }
  const { data, error } = await adminClient.rpc("roo_complete_contact_message", {
    p_id: row.id,
    p_sent: outcome.sent,
    p_provider_message_id: outcome.providerMessageId || null,
    p_error_code: outcome.errorCode || null,
  });
  if (error || typeof data !== "string") {
    logSafeError("contact_message_complete_failed", rpcError("complete", error));
    return { sent: outcome.sent, recorded: false };
  }
  if (data === "dead") {
    logSafeError("contact_message_dead", { code: outcome.errorCode, status: 502 });
  }
  return { sent: outcome.sent && data === "sent", recorded: true };
};

export async function submitContactMessage(
  { name, email, message, company, clientAddress } = {},
  { adminClient = createSupabaseAdminClient(), env = process.env } = {}
) {
  const values = validate({ name, email, message });
  const status = text(company) ? "spam" : "pending";
  const { data: id, error } = await adminClient.rpc("roo_record_contact_message", {
    p_name: values.name,
    p_email: values.email,
    p_message: values.message,
    p_client_hash: contactClientHash(clientAddress, env),
    p_status: status,
  });
  if (error || typeof id !== "string" || !id) throw rpcError("record", error);
  if (status === "spam") return { status: "spam", id };
  const result = await deliver({ id, ...values }, adminClient, env);
  return { status: result.sent && result.recorded ? "sent" : "queued", id };
}

export async function retryContactMessages(
  { limit = 20, deadline },
  { adminClient = createSupabaseAdminClient(), env = process.env } = {}
) {
  const summary = { claimed: 0, sent: 0, failed: 0 };
  while (summary.claimed < limit && deadline - Date.now() >= SEND_TIMEOUT_MS) {
    const { data, error } = await adminClient.rpc("roo_claim_contact_retries", { p_limit: 1 });
    if (error || !Array.isArray(data)) throw rpcError("claim", error);
    if (!data.length) break;
    summary.claimed += 1;
    const result = await deliver(data[0], adminClient, env);
    if (result.sent && result.recorded) summary.sent += 1;
    else summary.failed += 1;
  }
  return summary;
}
