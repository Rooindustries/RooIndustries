import { verifyHoldToken } from "../../booking/holdToken.js";
import {
  createCommerceReadClient,
  createCommerceWriteClient,
} from "../ref/sanity.js";
import {
  resolveSupabaseRuntimePolicy,
} from "../../supabase/runtime.js";
import { verifyPaymentAccessToken } from "./accessToken.js";
import { findPaymentRecordByProviderData } from "./paymentRecord.js";
import { verifyUpgradeIntentToken } from "../ref/upgradeIntentToken.js";
import sanityConfiguration from "../../supabase/sanityConfiguration.cjs";
import envValue from "../../supabase/envValue.cjs";

const { inspectSanityConfiguration } = sanityConfiguration;
const { normalizeBackend } = envValue;

export const selectPaymentAuthority = ({
  backendOwner = "sanity",
  cutoverGeneration = 0,
  policy = resolveSupabaseRuntimePolicy(),
} = {}) => {
  const embeddedGeneration = Math.max(0, Number(cutoverGeneration) || 0);
  const currentGeneration = Math.max(
    0,
    Number(policy.commerceFailoverGeneration) || 0
  );
  if (embeddedGeneration < currentGeneration) {
    return normalizeBackend(policy.commercePrimaryBackend, "supabase");
  }
  return normalizeBackend(backendOwner, "sanity");
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
  createReadClient = createPaymentBackendReadClient,
} = {}) => {
  const ids = webhookProviderData({ provider, body });
  if (ids.providerOrderId || ids.providerPaymentId) {
    const policy = resolveSupabaseRuntimePolicy(env);
    const activeBackend = normalizeBackend(
      policy.commercePrimaryBackend,
      "supabase"
    );
    const legacyBackend = activeBackend === "supabase" ? "sanity" : "supabase";
    const legacyBackendConfigured =
      legacyBackend !== "sanity" ||
      inspectSanityConfiguration(env).readConfigured;
    const backends = [
      activeBackend,
      ...(legacyBackendConfigured ? [legacyBackend] : []),
    ];
    for (const backend of backends) {
      try {
        const record = await findPaymentRecordByProviderData({
          client: createReadClient(backend),
          provider,
          ...ids,
        });
        if (record?._id) {
          return selectPaymentAuthority({
            backendOwner: record.backendOwner || backend,
            cutoverGeneration: record.cutoverGeneration,
            policy,
          });
        }
      } catch {
        // The other backend can still resolve an in-flight provider event.
      }
    }
  }
  return resolveSupabaseRuntimePolicy(env).commercePrimaryBackend;
};
