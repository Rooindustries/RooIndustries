import { verifyHoldToken } from "../../booking/holdToken.js";
import { createCommerceWriteClient } from "../ref/sanity.js";
import {
  resolveSupabaseRuntimePolicy,
} from "../../supabase/runtime.js";
import { verifyPaymentAccessToken } from "./accessToken.js";
import { findPaymentRecordByProviderData } from "./paymentRecord.js";
import { verifyUpgradeIntentToken } from "../ref/upgradeIntentToken.js";

const normalizeBackend = (value) =>
  String(value || "").trim().toLowerCase() === "supabase"
    ? "supabase"
    : "sanity";

export const getPaymentTokenBackend = (token) => {
  const result = verifyPaymentAccessToken({ token });
  if (!result.ok && !result.expired) return "";
  return normalizeBackend(result.payload?.backend);
};

export const selectPaymentStartBackend = ({
  body = {},
  clientAddress = "",
  cutoverGeneration,
  env = process.env,
} = {}) => {
  const policy = resolveSupabaseRuntimePolicy(env);
  const activeGeneration = cutoverGeneration === undefined
    ? policy.commerceFailoverGeneration
    : Math.max(0, Number(cutoverGeneration) || 0);
  if (activeGeneration >= 1) {
    return normalizeBackend(policy.commercePrimaryBackend);
  }

  const bookingPayload = body?.bookingPayload || {};
  const holdPayload = verifyHoldToken({
    token: bookingPayload.slotHoldToken,
    holdId: bookingPayload.slotHoldId,
    ignoreExpiry: true,
  });
  if (holdPayload?.hid) return normalizeBackend(holdPayload.be);

  if (bookingPayload.originalOrderId) {
    const upgradePayload = verifyUpgradeIntentToken({
      token: bookingPayload.upgradeIntentToken,
      bookingId: bookingPayload.originalOrderId,
      email: bookingPayload.email,
      targetPackageTitle: bookingPayload.packageTitle,
    });
    if (upgradePayload?.bid) return normalizeBackend(upgradePayload.be);
  }

  return normalizeBackend(policy.commercePrimaryBackend);
};

export const createPaymentBackendClient = (backend) =>
  createCommerceWriteClient({ backendOverride: normalizeBackend(backend) });

export const createPaymentBackendClientOverride = (
  backend,
  env = process.env
) =>
  normalizeBackend(backend) ===
  resolveSupabaseRuntimePolicy(env).commercePrimaryBackend
    ? null
    : createPaymentBackendClient(backend);

const webhookProviderData = ({ provider, body = {} }) => {
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
      related.capture_id || resource.capture_id || resource.id || ""
    ).trim(),
  };
};

export const resolveWebhookBackend = async ({
  provider,
  body,
  env = process.env,
} = {}) => {
  const ids = webhookProviderData({ provider, body });
  if (ids.providerOrderId || ids.providerPaymentId) {
    for (const backend of ["sanity", "supabase"]) {
      try {
        const record = await findPaymentRecordByProviderData({
          client: createPaymentBackendClient(backend),
          provider,
          ...ids,
        });
        if (record?._id) return normalizeBackend(record.backendOwner || backend);
      } catch {
        // The other backend can still resolve an in-flight provider event.
      }
    }
  }
  return resolveSupabaseRuntimePolicy(env).commercePrimaryBackend;
};
