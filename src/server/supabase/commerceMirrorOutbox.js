import crypto from "node:crypto";
import {
  pickReferralCommerceFields,
  REFERRAL_COMMERCE_FIELDS,
} from "../commerce/documentTypes.js";
import { getSafeErrorCode, logSafeError } from "../safeErrorLog.js";
import {
  buildMirrorMetadata,
  MIRROR_METADATA_KEYS,
  normalizeMirrorSequence,
  readMirrorSequence,
} from "./mirrorMetadata.js";
import { logSanityMirrorEvent } from "./mirrorObservability.js";
import { fetchShadowDocuments } from "./shadowStore.js";

const normalizeDocuments = (value) =>
  (Array.isArray(value) ? value : [])
    .filter((document) => document && typeof document === "object")
    .sort((left, right) =>
      String(left?._id || "").localeCompare(String(right?._id || ""))
    );

const normalizeIds = (value) =>
  [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort();

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

const mirrorExcludedKeys = new Set([
  "_rev",
  "_createdAt",
  "_updatedAt",
  "_system",
  "_commerceCutoverGeneration",
  ...MIRROR_METADATA_KEYS,
]);

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])])
  );
};

const cleanSourceDocument = (document) =>
  Object.fromEntries(
    Object.entries(document || {}).filter(
      ([key]) => !mirrorExcludedKeys.has(key)
    )
  );

const canonicalOwnedDocument = (document) => {
  const business = cleanSourceDocument(document);
  const owned =
    business._type === "referral"
      ? pickReferralCommerceFields(business)
      : business;
  return JSON.stringify(sortValue(owned));
};

const cleanForSanity = ({ document, current, event }) => ({
  ...cleanSourceDocument(document),
  ...buildMirrorMetadata({
    current,
    document,
    domain: "commerce",
    sequence: event?.sequence_no,
    canonicalHash: document?._supabaseCanonicalHash || event?.canonical_hash,
  }),
  _commerceCutoverGeneration: Math.max(
    0,
    Number(event?.cutover_generation) || 0
  ),
});

const cleanReferralAccountingForSanity = ({ document, current, event }) => {
  const clean = cleanForSanity({ document, current, event });
  return {
    ...pickReferralCommerceFields(clean),
    ...buildMirrorMetadata({
      current,
      document: clean,
      domain: "commerce",
      sequence: event?.sequence_no,
    }),
    _commerceCutoverGeneration: clean._commerceCutoverGeneration,
  };
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
      _commerceCutoverGeneration,
      _supabaseSequence,
      _supabaseSequences
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
    if (
      readMirrorSequence(current, "commerce") >
      normalizeMirrorSequence(event?.sequence_no)
    ) {
      return false;
    }
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

const fetchMirrorDocuments = async ({ sanityClient, ids }) => {
  if (ids.length < 1) return new Map();
  const documents = await sanityClient.fetch(
    `*[_id in $ids]`,
    { ids },
    { perspective: "raw" }
  );
  return new Map(
    normalizeDocuments(documents).map((document) => [String(document._id), document])
  );
};

const excludeDeletedReferralSources = async ({
  supabaseClient,
  currentById,
  documents,
}) => {
  const missingReferralIds = normalizeIds(
    documents
      .filter(
        (document) =>
          document?._type === "referral" &&
          !currentById.has(String(document?._id || ""))
      )
      .map((document) => document._id)
  );
  if (missingReferralIds.length < 1) return { documents, superseded: 0 };

  const authoritative = await fetchShadowDocuments({
    client: supabaseClient,
    documentTypes: ["referral"],
    ids: missingReferralIds,
    limit: missingReferralIds.length,
    allowLegacyFallback: false,
  });
  const authoritativeIds = new Set(
    normalizeDocuments(authoritative).map((document) => String(document._id))
  );
  const filtered = documents.filter(
    (document) =>
      document?._type !== "referral" ||
      currentById.has(String(document?._id || "")) ||
      authoritativeIds.has(String(document?._id || ""))
  );
  return {
    documents: filtered,
    superseded: documents.length - filtered.length,
  };
};

const buildReferralAccountingPatch = ({ current, document, event }) => {
  const set = cleanReferralAccountingForSanity({ current, document, event });
  const unset = REFERRAL_COMMERCE_FIELDS.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call(current || {}, field) &&
      !Object.prototype.hasOwnProperty.call(set, field)
  );
  return { set, unset };
};

const applyReferralAccounting = ({ transaction, current, document, event }) => {
  const update = buildReferralAccountingPatch({ current, document, event });
  if (!current) {
    return transaction.createIfNotExists({
      _id: document._id,
      _type: "referral",
      ...update.set,
    });
  }
  return transaction.patch(document._id, (patch) => {
    const guarded =
      current._rev && typeof patch.ifRevisionId === "function"
        ? patch.ifRevisionId(current._rev)
        : patch;
    const setPatch = guarded.set(update.set);
    return update.unset.length > 0 ? setPatch.unset(update.unset) : setPatch;
  });
};

const verifyCommerceProjection = async ({ sanityClient, documents, deletedIds, event }) => {
  const ids = normalizeIds([
    ...documents.map((document) => document._id),
    ...deletedIds,
  ]);
  const current = await fetchMirrorDocuments({ sanityClient, ids });
  const eventSequence = normalizeMirrorSequence(event?.sequence_no);
  for (const document of documents) {
    const target = current.get(String(document._id));
    if (!target) {
      const error = new Error("The commerce mirror target is missing.");
      error.code = "COMMERCE_MIRROR_VERIFICATION_FAILED";
      throw error;
    }
    const targetSequence = readMirrorSequence(target, "commerce");
    if (targetSequence > eventSequence) continue;
    if (
      targetSequence !== eventSequence ||
      canonicalOwnedDocument(target) !== canonicalOwnedDocument(document)
    ) {
      const error = new Error("The commerce mirror projection did not match.");
      error.code = "COMMERCE_MIRROR_VERIFICATION_FAILED";
      throw error;
    }
  }
  for (const id of deletedIds) {
    if (current.has(String(id))) {
      const error = new Error("The commerce mirror deletion was not visible.");
      error.code = "COMMERCE_MIRROR_VERIFICATION_FAILED";
      throw error;
    }
  }
};

const mirrorEventToSanity = async ({ supabaseClient, sanityClient, event }) => {
  const documents = normalizeDocuments(event?.documents);
  const documentIds = documents.map((document) => String(document?._id || ""));
  const currentById = await fetchMirrorDocuments({
    sanityClient,
    ids: documentIds.filter(Boolean),
  });
  const sourceFiltered = await excludeDeletedReferralSources({
    supabaseClient,
    currentById,
    documents,
  });
  const eventSequence = normalizeMirrorSequence(event?.sequence_no);
  const eligibleDocuments = sourceFiltered.documents.filter(
    (document) =>
      readMirrorSequence(currentById.get(String(document?._id || "")), "commerce") <=
      eventSequence
  );
  const eligibleDeletes = await guardedDeleteIds({ sanityClient, event });
  let transaction = sanityClient.transaction();
  for (const id of eligibleDeletes) transaction = transaction.delete(id);
  for (const document of eligibleDocuments) {
    const current = currentById.get(String(document._id));
    transaction =
      document?._type === "referral"
        ? applyReferralAccounting({ transaction, current, document, event })
        : transaction.createOrReplace(cleanForSanity({ document, current, event }));
  }
  const applied = eligibleDeletes.length + eligibleDocuments.length;
  if (applied > 0) {
    await transaction.commit();
    await verifyCommerceProjection({
      sanityClient,
      documents: eligibleDocuments,
      deletedIds: eligibleDeletes,
      event,
    });
  }
  return {
    applied,
    superseded:
      sourceFiltered.superseded +
      sourceFiltered.documents.length -
      eligibleDocuments.length +
      Math.max(0, normalizeIds(event?.deleted_ids).length - eligibleDeletes.length),
  };
};

export const drainCommerceMirrorOutbox = async ({
  supabaseClient,
  sanityClient,
  failClosed = false,
  requiredDocumentIds = [],
  limit = 25,
  maxBatches = 4,
} = {}) => {
  if (!supabaseClient?.rpc || !sanityClient?.transaction) {
    if (failClosed) {
      const error = new Error("Commerce fallback mirroring is unavailable.");
      error.code = "COMMERCE_MIRROR_UNAVAILABLE";
      error.status = 503;
      error.statusCode = 503;
      throw error;
    }
    return { supported: false, attempted: 0, mirrored: 0, failed: 0 };
  }

  const summary = { supported: true, attempted: 0, mirrored: 0, failed: 0 };
  const requiredIds = normalizeIds(requiredDocumentIds);
  const eventIsRequired = (event) =>
    requiredIds.length < 1 ||
    normalizeIds(event?.document_ids).some((id) => requiredIds.includes(id));
  const finish = async () => {
    if (failClosed) {
      const backlog = requireRpc(
        requiredIds.length > 0
          ? await supabaseClient.rpc("roo_commerce_mirror_status_for_ids", {
              p_document_ids: requiredIds,
            })
          : await supabaseClient.rpc("roo_commerce_mirror_backlog"),
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
        if (failClosed) {
          const failure = new Error("Commerce fallback mirroring is unavailable.");
          failure.code = "COMMERCE_MIRROR_UNAVAILABLE";
          failure.status = 503;
          failure.statusCode = 503;
          failure.cause = error;
          throw failure;
        }
        return { ...summary, supported: false };
      }
      if (failClosed) throw error;
      logSafeError("Commerce mirror outbox claim failed", error);
      logSanityMirrorEvent({
        event: "sanity_mirror_lag",
        reason: "outbox_unavailable",
        domain: "commerce",
      });
      return summary;
    }

    if (!Array.isArray(events)) return { ...summary, supported: false };
    if (events.length < 1) return finish();
    for (const event of events) {
      summary.attempted += 1;
      try {
        const mirrored = await mirrorEventToSanity({
          supabaseClient,
          sanityClient,
          event,
        });
        const superseded = mirrored.applied < 1 && mirrored.superseded > 0;
        requireRpc(
          await supabaseClient.rpc("roo_complete_commerce_mirror_event", {
            p_event_key: event.event_key,
            p_lease_id: leaseId,
            p_success: true,
            p_error_code: superseded
              ? "SUPERSEDED_BY_NEWER_SEQUENCE"
              : null,
          }),
          "commerce mirror completion"
        );
        summary.mirrored += superseded ? 0 : 1;
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
          logSanityMirrorEvent({
            event: "sanity_mirror_lag",
            reason: "recovery_queue_unavailable",
            domain: "commerce",
          });
        }
        if (failClosed && eventIsRequired(event)) {
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
        logSanityMirrorEvent({
          event: "sanity_mirror_lag",
          reason: "delivery_failed",
          domain: "commerce",
        });
      }
    }
    if (events.length < Math.max(1, Math.min(100, Number(limit) || 25))) {
      return finish();
    }
  }
  return finish();
};
