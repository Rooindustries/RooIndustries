import { verifyHoldToken } from "../../booking/holdToken.js";
import {
  createCommerceReadClient,
  createCommerceWriteClient,
} from "../ref/documentStore.js";
import {
  resolveSupabaseRuntimePolicy,
} from "../../supabase/runtime.js";
import { verifyPaymentAccessToken } from "./accessToken.js";
import { getPayPalRefundCaptureId } from "./providerClients.js";
import { findPaymentRecordByProviderData } from "./paymentRecord.js";
import { verifyUpgradeIntentToken } from "../ref/upgradeIntentToken.js";
import envValue from "../../supabase/envValue.cjs";

const { normalizeBackend } = envValue;

export const selectPaymentAuthority = ({
  backendOwner = "supabase",
  cutoverGeneration = 0,
  policy = resolveSupabaseRuntimePolicy(),
} = {}) => {
  return normalizeBackend(backendOwner);
};

export const getPaymentTokenBackend = (token, env = process.env) => {
  const result = verifyPaymentAccessToken({ token });
  if (!result.ok && !result.expired) return "";
  return selectPaymentAuthority({
    backendOwner: result.payload?.backend,
    cutoverGeneration: result.payload?.cutoverGeneration,
    policy: resolveSupabaseRuntimePolicy(env),
  });
};

export const selectPaymentStartBackend = ({
  body = {},
  clientAddress = "",
  cutoverGeneration,
  env = process.env,
} = {}) => {
  const policy = resolveSupabaseRuntimePolicy(env);
  const normalizedGeneration = String(cutoverGeneration ?? "").trim();
  const activeGeneration = normalizedGeneration === ""
    ? policy.commerceFailoverGeneration
    : Math.max(0, Number(normalizedGeneration) || 0);
  if (activeGeneration >= 1) {
    return normalizeBackend(policy.commercePrimaryBackend, "supabase");
  }

  const bookingPayload = body?.bookingPayload || {};
  const holdPayload = verifyHoldToken({
    token: bookingPayload.slotHoldToken,
    holdId: bookingPayload.slotHoldId,
    ignoreExpiry: true,
  });
  if (holdPayload?.hid) return normalizeBackend(holdPayload.be, "sanity");

  if (bookingPayload.originalOrderId) {
    const upgradePayload = verifyUpgradeIntentToken({
      token: bookingPayload.upgradeIntentToken,
      bookingId: bookingPayload.originalOrderId,
      email: bookingPayload.email,
      targetPackageTitle: bookingPayload.packageTitle,
    });
    if (upgradePayload?.bid) {
      return normalizeBackend(upgradePayload.be, "sanity");
    }
  }

  return normalizeBackend(policy.commercePrimaryBackend, "supabase");
};

export const createPaymentBackendClient = (backend) =>
  createCommerceWriteClient({
    backendOverride: normalizeBackend(backend, "supabase"),
  });

export const createPaymentBackendReadClient = (backend) =>
  createCommerceReadClient({
    backendOverride: normalizeBackend(backend, "supabase"),
  });

export const createPaymentBackendClientOverride = (
  backend,
  env = process.env
) =>
  normalizeBackend(backend, "supabase") ===
  resolveSupabaseRuntimePolicy(env).commercePrimaryBackend
    ? null
    : createPaymentBackendClient(backend);

const webhookProviderData = ({ provider, body = {} }) => {
  if (provider === "dodo") return { providerOrderId: String(body?.data?.checkout_session_id || ""), providerPaymentId: String(body?.data?.payment_id || "") };
  if (provider === "razorpay") {
    const payment = body?.payload?.payment?.entity || {};
    const refund = body?.payload?.refund?.entity || {};
    return {
      providerOrderId: String(payment.order_id || "").trim(),
      providerPaymentId: String(payment.id || refund.payment_id || "").trim(),
    };
  }
  const resource = body?.resource || {};
  const related = resource?.supplementary_data?.related_ids || {};
  return {
    providerOrderId: String(related.order_id || "").trim(),
    providerPaymentId: String(
      String(body.event_type || "").includes("REFUND")
        ? getPayPalRefundCaptureId(resource)
        : related.capture_id || resource.capture_id || resource.id || ""
    ).trim(),
  };
};

export const resolveWebhookBackend = async ({
  provider,
  body,
  env = process.env,
  createReadClient = createPaymentBackendReadClient,
} = {}) => {
  const ids = webhookProviderData({ provider, body });
  if (ids.providerOrderId || ids.providerPaymentId) {
    const policy = resolveSupabaseRuntimePolicy(env);
    const record = await findPaymentRecordByProviderData({ client: createReadClient("supabase"), provider, ...ids });
    if (record?._id) return selectPaymentAuthority({backendOwner:record.backendOwner,cutoverGeneration:record.cutoverGeneration,policy});
  }
  return resolveSupabaseRuntimePolicy(env).commercePrimaryBackend;
};
