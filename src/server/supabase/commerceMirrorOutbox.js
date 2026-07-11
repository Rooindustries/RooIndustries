import crypto from "node:crypto";
import { getSafeErrorCode, logSafeError } from "../safeErrorLog.js";

const normalizeDocuments = (value) =>
  (Array.isArray(value) ? value : [])
    .filter((document) => document && typeof document === "object")
    .sort((left, right) =>
      String(left?._id || "").localeCompare(String(right?._id || ""))
    );

const normalizeIds = (value) =>
  [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort();

const REFERRAL_COMMERCE_FIELDS = Object.freeze([
  "successfulReferrals",
  "currentCommissionPercent",
  "currentDiscountPercent",
  "isFirstTime",
  "xocPayments",
  "vertexPayments",
  "earnedXoc",
  "earnedVertex",
  "earnedTotal",
  "paidXoc",
  "paidVertex",
  "paidTotal",
  "owedXoc",
  "owedVertex",
  "owedTotal",
  "notes",
]);

const isMissingRpc = (error) =>
  ["42883", "PGRST202"].includes(String(error?.code || ""));

const requireRpc = ({ data, error }, operation) => {
  if (!error) return data;
  const failure = new Error(`Supabase ${operation} failed.`);
  failure.code = error.code || "SUPABASE_MIRROR_OUTBOX_FAILED";
  failure.status = isMissingRpc(error) ? 501 : 503;
  failure.statusCode = failure.status;
  throw failure;
};

const cleanForSanity = ({ document, event }) => {
  const {
    _rev: supabaseRevision,
    _createdAt,
    _updatedAt,
    _supabaseCanonicalHash: documentCanonicalHash,
    ...clean
  } = document;
  return {
    ...clean,
    _supabaseRevision: String(supabaseRevision || ""),
    _supabaseCanonicalHash: String(
      documentCanonicalHash || event?.canonical_hash || ""
    ),
    _commerceCutoverGeneration: Math.max(
      0,
      Number(event?.cutover_generation) || 0
    ),
    _supabaseMirroredAt: new Date().toISOString(),
  };
};

const cleanReferralAccountingForSanity = ({ document, event }) => {
  const clean = cleanForSanity({ document, event });
  return REFERRAL_COMMERCE_FIELDS.reduce(
    (result, field) => {
      if (Object.prototype.hasOwnProperty.call(clean, field)) {
        result[field] = clean[field];
      }
      return result;
    },
    {
      _supabaseRevision: clean._supabaseRevision,
      _supabaseCanonicalHash: clean._supabaseCanonicalHash,
      _commerceCutoverGeneration: clean._commerceCutoverGeneration,
      _supabaseMirroredAt: clean._supabaseMirroredAt,
    }
  );
};

const guardedDeleteIds = async ({ sanityClient, event }) => {
  const deletedIds = normalizeIds(event?.deleted_ids);
  if (deletedIds.length < 1) return [];
  if (typeof sanityClient?.fetch !== "function") {
    const error = new Error("Sanity delete guard lookup is unavailable.");
    error.code = "COMMERCE_MIRROR_DELETE_GUARD_UNAVAILABLE";
    throw error;
  }
  const currentDocuments = await sanityClient.fetch(
    `*[_id in $ids]{
      _id,
      _rev,
      _supabaseRevision,
      _supabaseCanonicalHash,
      _commerceCutoverGeneration
    }`,
    { ids: deletedIds }
  );
  const currentById = new Map(
    (Array.isArray(currentDocuments) ? currentDocuments : [])
      .filter((document) => document?._id)
      .map((document) => [String(document._id), document])
  );

  return deletedIds.filter((id) => {
    const current = currentById.get(id);
    if (!current) return false;
    const guard = event?.delete_guards?.[id];
    const guardedRevision = String(guard?.source_revision || "");
    const currentRevision = String(
      current._supabaseRevision || current._rev || ""
    );
    const hashMismatch =
      current._supabaseCanonicalHash &&
      guard?.canonical_hash &&
      String(current._supabaseCanonicalHash) !== String(guard.canonical_hash);
    const generationMismatch =
      current._commerceCutoverGeneration !== undefined &&
      Number(current._commerceCutoverGeneration) !==
        Math.max(0, Number(guard?.cutover_generation) || 0);
    if (
      !guardedRevision ||
      currentRevision !== guardedRevision ||
      hashMismatch ||
      generationMismatch
    ) {
      const error = new Error(
        "A newer Sanity document replaced the mirrored delete target."
      );
      error.code = "COMMERCE_MIRROR_DELETE_CONFLICT";
      throw error;
    }
    return true;
  });
};

const mirrorEventToSanity = async ({ sanityClient, event }) => {
  let transaction = sanityClient.transaction();
  for (const id of await guardedDeleteIds({ sanityClient, event })) {
    transaction = transaction.delete(id);
  }
  for (const document of normalizeDocuments(event?.documents)) {
    if (document?._type === "referral") {
      const accounting = cleanReferralAccountingForSanity({ document, event });
      transaction = transaction.patch(document._id, (patch) =>
        patch.set(accounting)
      );
      continue;
    }
    transaction = transaction.createOrReplace(cleanForSanity({ document, event }));
  }
  await transaction.commit();
};

export const drainCommerceMirrorOutbox = async ({
  supabaseClient,
  sanityClient,
  failClosed = false,
  limit = 25,
  maxBatches = 4,
} = {}) => {
  if (!supabaseClient?.rpc || !sanityClient?.transaction) {
    return { supported: false, attempted: 0, mirrored: 0, failed: 0 };
  }

  const summary = { supported: true, attempted: 0, mirrored: 0, failed: 0 };
  const finish = async () => {
    if (failClosed) {
      const backlog = requireRpc(
        await supabaseClient.rpc("roo_commerce_mirror_backlog"),
        "commerce mirror backlog check"
      );
      if (Number(backlog?.pending || 0) > 0) {
        const error = new Error("Commerce fallback mirroring remains pending.");
        error.code = "COMMERCE_MIRROR_PENDING";
        error.status = 503;
        error.statusCode = 503;
        throw error;
      }
    }
    return summary;
  };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const leaseId = crypto.randomUUID();
    let events;
    try {
      events = requireRpc(
        await supabaseClient.rpc("roo_claim_commerce_mirror_events", {
          p_lease_id: leaseId,
          p_limit: Math.max(1, Math.min(100, Number(limit) || 25)),
          p_force: failClosed,
        }),
        "commerce mirror claim"
      );
    } catch (error) {
      if (isMissingRpc(error) || Number(error?.status) === 501) {
        return { ...summary, supported: false };
      }
      if (failClosed) throw error;
      logSafeError("Commerce mirror outbox claim failed", error);
      return summary;
    }

    if (!Array.isArray(events)) return { ...summary, supported: false };
    if (events.length < 1) return finish();
    for (const event of events) {
      summary.attempted += 1;
      try {
        await mirrorEventToSanity({ sanityClient, event });
        requireRpc(
          await supabaseClient.rpc("roo_complete_commerce_mirror_event", {
            p_event_key: event.event_key,
            p_lease_id: leaseId,
            p_success: true,
            p_error_code: null,
          }),
          "commerce mirror completion"
        );
        summary.mirrored += 1;
      } catch (error) {
        summary.failed += 1;
        try {
          requireRpc(
            await supabaseClient.rpc("roo_complete_commerce_mirror_event", {
              p_event_key: event.event_key,
              p_lease_id: leaseId,
              p_success: false,
              p_error_code: getSafeErrorCode(error, "MIRROR_FAILED"),
            }),
            "commerce mirror retry"
          );
        } catch (completionError) {
          logSafeError("Commerce mirror retry recording failed", completionError);
        }
        if (failClosed) {
          const failure = new Error(
            "The commerce write is safe, but its Sanity fallback mirror is still pending."
          );
          failure.code = "COMMERCE_MIRROR_PENDING";
          failure.status = 503;
          failure.statusCode = 503;
          failure.cause = error;
          throw failure;
        }
        logSafeError("Commerce fallback mirror failed", error);
      }
    }
    if (events.length < Math.max(1, Math.min(100, Number(limit) || 25))) {
      return finish();
    }
  }
  if (failClosed && summary.failed > 0) {
    const error = new Error("Commerce fallback mirroring remains pending.");
    error.code = "COMMERCE_MIRROR_PENDING";
    error.status = 503;
    error.statusCode = 503;
    throw error;
  }
  return finish();
};
