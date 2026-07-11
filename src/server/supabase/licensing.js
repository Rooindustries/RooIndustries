import crypto from "node:crypto";
import { createSupabaseAdminClient } from "./adminClient.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

const requireData = ({ data, error }, operation) => {
  if (error) {
    const failure = new Error(`Supabase ${operation} failed.`);
    failure.code = error.code || "SUPABASE_LICENSING_FAILED";
    failure.status = error.status || 500;
    throw failure;
  }
  return data;
};

export const hashDeviceFingerprint = ({ fingerprint, secret } = {}) => {
  const normalized = String(fingerprint || "").trim();
  const key = String(secret || "").trim();
  if (normalized.length < 16 || normalized.length > 512) {
    throw Object.assign(new Error("Invalid hardware fingerprint."), { status: 400 });
  }
  if (key.length < 32) {
    throw Object.assign(new Error("Device hashing is not configured."), { status: 503 });
  }
  return crypto.createHmac("sha256", key).update(normalized).digest("hex");
};

export const normalizeEntitlementId = (value) => {
  const id = String(value || "").trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    throw Object.assign(new Error("Invalid entitlement."), { status: 400 });
  }
  return id;
};

export const normalizeRequestId = (value) => {
  const requestId = String(value || "").trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw Object.assign(new Error("Invalid request ID."), { status: 400 });
  }
  return requestId;
};

export const getEntitlementStatus = async ({
  userId,
  client = createSupabaseAdminClient(),
} = {}) =>
  requireData(
    await client.rpc("roo_entitlement_status", { p_user_id: userId }),
    "entitlement status"
  );

export const claimEntitlement = async ({
  userId,
  verifiedEmail,
  purchaseReference = null,
  client = createSupabaseAdminClient(),
} = {}) => {
  const reference = String(purchaseReference || "").trim();
  if (reference.length > 200) {
    throw Object.assign(new Error("Invalid purchase reference."), { status: 400 });
  }
  return requireData(
    await client.rpc("roo_claim_entitlement", {
      p_user_id: userId,
      p_verified_email: String(verifiedEmail || "").trim().toLowerCase(),
      p_purchase_reference: reference || null,
    }),
    "entitlement claim"
  );
};

export const activateEntitlementDevice = async ({
  userId,
  entitlementId,
  fingerprint,
  requestId,
  deviceLabel = null,
  appVersion = null,
  env = process.env,
  client = createSupabaseAdminClient({ env }),
} = {}) => {
  const label = String(deviceLabel || "").trim().slice(0, 120) || null;
  const version = String(appVersion || "").trim().slice(0, 80) || null;
  const result = requireData(
    await client.rpc("roo_activate_device", {
      p_user_id: userId,
      p_entitlement_id: normalizeEntitlementId(entitlementId),
      p_device_fingerprint_hmac: hashDeviceFingerprint({
        fingerprint,
        secret: env.APP_DEVICE_HASH_SECRET,
      }),
      p_request_id: normalizeRequestId(requestId),
      p_device_label: label,
      p_app_version: version,
    }),
    "device activation"
  );
  if (result?.status === "device_limit_reached") {
    const failure = new Error("device limit reached");
    failure.code = "23505";
    throw failure;
  }
  return result;
};

export const revokeEntitlementDevice = async ({
  entitlementId,
  requestId,
  reason,
  actorUserId = null,
  client = createSupabaseAdminClient(),
} = {}) =>
  requireData(
    await client.rpc("roo_revoke_device", {
      p_entitlement_id: normalizeEntitlementId(entitlementId),
      p_request_id: normalizeRequestId(requestId),
      p_reason: String(reason || "Manual administrator reset").trim().slice(0, 500),
      p_actor_user_id: actorUserId || null,
    }),
    "device revocation"
  );

export const licensingErrorResponse = (error) => {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (Number(error?.status || 0) === 400) {
    return { status: 400, error: message || "Invalid request." };
  }
  if (Number(error?.status || 0) === 503) {
    return { status: 503, error: "Licensing is temporarily unavailable." };
  }
  if (code === "P0002") {
    return { status: 404, error: "No eligible purchase was found." };
  }
  if (code === "23505" || /device limit reached/i.test(message)) {
    return {
      status: 409,
      error: "This purchase is already active on another PC.",
    };
  }
  return { status: 500, error: "Licensing is temporarily unavailable." };
};
