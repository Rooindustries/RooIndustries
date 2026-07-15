import { createDocumentWriteClient } from "../data/documentClient.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;

const fail = (message, status = 400, code = "INVALID_CREATOR_TERMS") => {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  error.code = code;
  throw error;
};

export const percentToBasisPoints = (value, label) => {
  const text = String(value ?? "").trim();
  if (!/^(?:\d{1,2}(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/.test(text)) {
    fail(`${label} must be between 0 and 100 with at most two decimal places.`);
  }
  const basisPoints = Math.round(Number(text) * 100);
  if (basisPoints < 0 || basisPoints > 10000) {
    fail(`${label} must be between 0 and 100.`);
  }
  return basisPoints;
};

export const validateCreatorTermsUpdate = (input = {}) => {
  const creatorId = String(input.creatorId || "").trim();
  const operationId = String(input.operationId || "").trim();
  const expectedVersion = Number(input.expectedVersion);
  const reason = String(input.reason || "").trim();
  if (!UUID_PATTERN.test(creatorId)) fail("A valid creator is required.");
  if (!OPERATION_PATTERN.test(operationId)) fail("A valid operation ID is required.");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    fail("The creator version is invalid.");
  }
  if (reason.length < 3 || reason.length > 500) {
    fail("Add a reason between 3 and 500 characters.");
  }
  const totalBasisPoints = percentToBasisPoints(input.totalPercent, "Total percentage");
  const commissionBasisPoints = percentToBasisPoints(
    input.commissionPercent,
    "Creator commission"
  );
  const discountBasisPoints = percentToBasisPoints(
    input.discountPercent,
    "Customer discount"
  );
  if (commissionBasisPoints + discountBasisPoints > totalBasisPoints) {
    fail("Commission and discount cannot exceed the total percentage.");
  }
  if (typeof input.bypassUnlock !== "boolean") {
    fail("The eligibility bypass value is invalid.");
  }
  return {
    creatorId,
    operationId,
    expectedVersion,
    reason,
    totalBasisPoints,
    commissionBasisPoints,
    discountBasisPoints,
    bypassUnlock: input.bypassUnlock,
  };
};

const requireRpc = ({ data, error }, operation) => {
  if (!error) return data;
  const failure = new Error(`${operation} failed.`);
  failure.code = String(error.code || "SUPABASE_CREATOR_TERMS_FAILED");
  failure.details = error.details;
  failure.cause = error;
  throw failure;
};

export const listCreatorTerms = async ({
  client,
  search = "",
  limit = 100,
  offset = 0,
}) => {
  const normalizedSearch = String(search || "").trim();
  if (normalizedSearch.length > 100) fail("Search is too long.");
  const normalizedOffset = Number(offset);
  if (
    !Number.isSafeInteger(normalizedOffset) ||
    normalizedOffset < 0 ||
    normalizedOffset > 1_000_000
  ) {
    fail("The creator page offset is invalid.");
  }
  return requireRpc(
    await client.rpc("roo_admin_list_creator_terms", {
      p_search: normalizedSearch,
      p_limit: Math.max(1, Math.min(200, Number(limit) || 100)),
      p_offset: normalizedOffset,
    }),
    "Creator lookup"
  );
};

export const getCreatorTermsHistory = async ({ client, creatorId, limit = 20 }) => {
  if (!UUID_PATTERN.test(String(creatorId || ""))) fail("A valid creator is required.");
  return requireRpc(
    await client.rpc("roo_admin_creator_terms_history", {
      p_creator_id: creatorId,
      p_limit: Math.max(1, Math.min(100, Number(limit) || 20)),
    }),
    "Creator audit lookup"
  );
};

export const updateCreatorTerms = async ({ client, input, cutoverGeneration }) => {
  const values = validateCreatorTermsUpdate(input);
  return requireRpc(
    await client.rpc("roo_admin_update_creator_terms", {
      p_command_id: values.operationId,
      p_creator_id: values.creatorId,
      p_expected_version: values.expectedVersion,
      p_total_basis_points: values.totalBasisPoints,
      p_commission_basis_points: values.commissionBasisPoints,
      p_discount_basis_points: values.discountBasisPoints,
      p_bypass_referral_requirement: values.bypassUnlock,
      p_reason: values.reason,
      p_cutover_generation: Math.max(0, Number(cutoverGeneration) || 0),
    }),
    "Creator terms update"
  );
};

export const flushCreatorTermsMirror = async ({ client, legacySanityId }) => {
  const documentId = String(legacySanityId || "").trim();
  if (!documentId) return { syncPending: true };
  try {
    const writeClient = createDocumentWriteClient({
      backendOverride: "supabase",
      domain: "commerce",
      supabaseClient: client,
    });
    if (typeof writeClient.flushCommerceMirror !== "function") {
      return { syncPending: true };
    }
    await writeClient.flushCommerceMirror({
      failClosed: false,
      requiredDocumentIds: [documentId],
      limit: 25,
      maxBatches: 2,
    });
    const status = requireRpc(
      await client.rpc("roo_commerce_mirror_status_for_ids", {
        p_document_ids: [documentId],
      }),
      "Creator mirror status"
    );
    return { syncPending: Number(status?.pending || 0) > 0 };
  } catch {
    return { syncPending: true };
  }
};
