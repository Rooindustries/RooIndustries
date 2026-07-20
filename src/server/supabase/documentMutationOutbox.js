import crypto from "node:crypto";
import {
  isReferralCommerceField,
  pickReferralGeneralFields,
} from "../commerce/documentTypes.js";
import { getSafeErrorCode, logSafeError } from "../safeErrorLog.js";
import {
  buildMirrorMetadata,
  MIRROR_METADATA_KEYS,
  normalizeMirrorSequence,
  readMirrorSequence,
} from "./mirrorMetadata.js";
import { logSanityMirrorEvent } from "./mirrorObservability.js";

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
  failure.code = error.code || "DOCUMENT_MIRROR_OUTBOX_FAILED";
  failure.status = isMissingRpc(error) ? 501 : 503;
  failure.statusCode = failure.status;
  throw failure;
};

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortValue(value[key]);
      return result;
    }, {});
};

const canonicalExcludedKeys = new Set([
  "_rev",
  "_createdAt",
  "_updatedAt",
  "_originalId",
  "_system",
  "_commerceCutoverGeneration",
  ...MIRROR_METADATA_KEYS,
]);

const cleanSourceDocument = (document) =>
  Object.fromEntries(
    Object.entries(document || {}).filter(
      ([key]) => !canonicalExcludedKeys.has(key)
    )
  );

const canonicalDocument = (document) => {
  const business = cleanSourceDocument(document);
  const owned =
    business._type === "referral"
      ? pickReferralGeneralFields(business)
      : business;
  return JSON.stringify(sortValue(owned));
};

const cleanForSanity = ({ document, current, eventSequence }) => ({
  ...cleanSourceDocument(document),
  ...buildMirrorMetadata({
    current,
    document,
    domain: "global",
    sequence: eventSequence,
  }),
});

const conflict = (message) => {
  const error = new Error(message);
  error.code = "DOCUMENT_MIRROR_SEQUENCE_CONFLICT";
  return error;
};

const verificationFailure = (message) => {
  const error = new Error(message);
  error.code = "DOCUMENT_MIRROR_VERIFICATION_FAILED";
  return error;
};

const matchingCanonicalHash = (current, document) =>
  document?._type === "referral" ||
  String(current?._supabaseCanonicalHash || "") ===
    String(document?._supabaseCanonicalHash || "");

const planUpsert = ({ current, document, eventSequence }) => {
  const value = cleanForSanity({ document, current, eventSequence });
  if (!current) return { operation: "upsert", value, current: null };
  const currentSequence = readMirrorSequence(current, "global");
  if (currentSequence > eventSequence) return { operation: "superseded" };
  if (currentSequence < eventSequence) {
    return { operation: "upsert", value, current };
  }
  if (
    matchingCanonicalHash(current, document) &&
    canonicalDocument(current) === canonicalDocument(document)
  ) {
    return { operation: "idempotent" };
  }
  throw conflict("A Sanity document has conflicting data at the same mirror sequence.");
};

const planDelete = ({ current, document, eventSequence }) => {
  if (!current) return { operation: "idempotent" };
  const currentSequence = readMirrorSequence(current, "global");
  if (currentSequence > eventSequence) return { operation: "superseded" };
  if (currentSequence > 0n && currentSequence < eventSequence) {
    return { operation: "delete", id: document._id };
  }
  if (currentSequence === eventSequence && currentSequence > 0n) {
    throw conflict("A deleted Sanity document was recreated at the same mirror sequence.");
  }
  if (canonicalDocument(current) !== canonicalDocument(document)) {
    throw conflict("An untracked Sanity document changed before its delete was mirrored.");
  }
  return { operation: "delete", id: document._id };
};

const fetchCurrentDocuments = async ({ sanityClient, ids }) => {
  if (ids.length < 1) return new Map();
  if (typeof sanityClient?.fetch !== "function") {
    throw new Error("Sanity mirror reads are unavailable.");
  }
  const current = await sanityClient.fetch(
    `*[_id in $ids]`,
    { ids },
    { perspective: "raw" }
  );
  return new Map(
    normalizeDocuments(current).map((document) => [String(document._id), document])
  );
};

const planEvent = async ({ sanityClient, event }) => {
  const documents = normalizeDocuments(event?.documents);
  const deleted = normalizeDocuments(event?.deleted_documents);
  const ids = normalizeIds([
    ...documents.map((document) => document._id),
    ...deleted.map((document) => document._id),
  ]);
  const current = await fetchCurrentDocuments({ sanityClient, ids });
  const eventSequence = normalizeMirrorSequence(event?.sequence_no);
  const operations = [
    ...deleted.map((document) =>
      planDelete({ current: current.get(document._id), document, eventSequence })
    ),
    ...documents.map((document) =>
      planUpsert({ current: current.get(document._id), document, eventSequence })
    ),
  ];
  return operations;
};

const immutableSanityKeys = new Set([
  "_id",
  "_type",
  "_rev",
  "_createdAt",
  "_updatedAt",
  "_originalId",
  "_system",
]);

const buildReferralPatch = ({ current, value }) => {
  const set = pickReferralGeneralFields(value);
  delete set._id;
  delete set._type;
  const unset = Object.keys(current || {}).filter(
    (key) =>
      !immutableSanityKeys.has(key) &&
      !isReferralCommerceField(key) &&
      key !== "_commerceCutoverGeneration" &&
      !Object.prototype.hasOwnProperty.call(set, key)
  );
  return { set, unset };
};

const applyReferralUpsert = ({ transaction, operation }) => {
  if (!operation.current) return transaction.createIfNotExists(operation.value);
  const update = buildReferralPatch(operation);
  return transaction.patch(operation.value._id, (patch) => {
    const guarded =
      operation.current._rev && typeof patch.ifRevisionId === "function"
        ? patch.ifRevisionId(operation.current._rev)
        : patch;
    const setPatch = guarded.set(update.set);
    return update.unset.length > 0 ? setPatch.unset(update.unset) : setPatch;
  });
};

const applyEvent = async ({ sanityClient, event }) => {
  const operations = await planEvent({ sanityClient, event });
  let transaction = sanityClient.transaction();
  let mutations = 0;
  for (const operation of operations) {
    if (operation.operation === "delete") {
      transaction = transaction.delete(operation.id);
      mutations += 1;
    } else if (operation.operation === "upsert") {
      transaction =
        operation.value?._type === "referral"
          ? applyReferralUpsert({ transaction, operation })
          : transaction.createOrReplace(operation.value);
      mutations += 1;
    }
  }
  if (mutations > 0) await transaction.commit({ visibility: "sync" });
  return {
    mutations,
    idempotent: operations.filter((item) => item.operation === "idempotent").length,
    superseded: operations.filter((item) => item.operation === "superseded").length,
  };
};

const verifyEvent = async ({ sanityClient, event }) => {
  const documents = normalizeDocuments(event?.documents);
  const deleted = normalizeDocuments(event?.deleted_documents);
  const ids = normalizeIds([
    ...documents.map((document) => document._id),
    ...deleted.map((document) => document._id),
  ]);
  const current = await fetchCurrentDocuments({ sanityClient, ids });
  const eventSequence = normalizeMirrorSequence(event?.sequence_no);

  for (const document of documents) {
    const target = current.get(String(document._id));
    if (!target) {
      throw verificationFailure("The mirrored Sanity document is missing after commit.");
    }
    const targetSequence = readMirrorSequence(target, "global");
    if (targetSequence > eventSequence) continue;
    if (
      targetSequence !== eventSequence ||
      !matchingCanonicalHash(target, document) ||
      canonicalDocument(target) !== canonicalDocument(document)
    ) {
      throw verificationFailure(
        "The mirrored Sanity document did not match the committed source event."
      );
    }
  }

  for (const document of deleted) {
    const target = current.get(String(document._id));
    if (!target) continue;
    if (readMirrorSequence(target, "global") > eventSequence) continue;
    throw verificationFailure("The mirrored Sanity deletion was not visible after commit.");
  }
};

const completeEvent = async ({ supabaseClient, event, leaseId, success, error }) =>
  requireRpc(
    await supabaseClient.rpc("roo_complete_document_mutation_mirror_event", {
      p_event_key: event.event_key,
      p_lease_id: leaseId,
      p_success: success,
      p_error_code: success ? null : getSafeErrorCode(error, "MIRROR_FAILED"),
    }),
    "document mirror completion"
  );

const emptySummary = () => ({
  supported: true,
  attempted: 0,
  applied: 0,
  mutations: 0,
  idempotent: 0,
  superseded: 0,
  retried: 0,
  deadLettered: 0,
  budgetExhausted: false,
});

const readRequiredStatus = async ({ supabaseClient, requiredDocumentIds }) =>
  requireRpc(
    await supabaseClient.rpc("roo_document_mutation_mirror_status_for_ids", {
      p_document_ids: requiredDocumentIds,
    }),
    "document mirror status"
  );

const readBacklog = async ({ supabaseClient, requiredDocumentIds }) => {
  const backlog = requireRpc(
    await supabaseClient.rpc("roo_document_mutation_mirror_backlog", {}),
    "document mirror backlog"
  );
  const required = requiredDocumentIds.length > 0
    ? await readRequiredStatus({ supabaseClient, requiredDocumentIds })
    : null;
  return { backlog: backlog || {}, required };
};

const claimBatch = async ({ supabaseClient, leaseId, limit, preferredIds }) =>
  requireRpc(
    await supabaseClient.rpc("roo_claim_document_mutation_mirror_events", {
      p_lease_id: leaseId,
      p_limit: limit,
      p_lease_seconds: 120,
      p_preferred_document_ids: preferredIds.length > 0 ? preferredIds : null,
    }),
    "document mirror claim"
  );

const processEvent = async ({
  supabaseClient,
  sanityClient,
  event,
  leaseId,
  summary,
}) => {
  summary.attempted += 1;
  try {
    const applied = await applyEvent({ sanityClient, event });
    await verifyEvent({ sanityClient, event });
    await completeEvent({ supabaseClient, event, leaseId, success: true });
    summary.applied += 1;
    summary.mutations += applied.mutations;
    summary.idempotent += applied.idempotent;
    summary.superseded += applied.superseded;
  } catch (error) {
    try {
      const completion = await completeEvent({
        supabaseClient,
        event,
        leaseId,
        success: false,
        error,
      });
      if (completion?.status === "dead_letter") summary.deadLettered += 1;
      else summary.retried += 1;
    } catch (completionError) {
      logSafeError("Document mirror retry recording failed", completionError);
      logSanityMirrorEvent({
        event: "sanity_mirror_lag",
        reason: "recovery_queue_unavailable",
        domain: "global",
      });
    }
    logSafeError("Document fallback mirror failed", error);
    logSanityMirrorEvent({
      event: "sanity_mirror_lag",
      reason: "delivery_failed",
      domain: "global",
    });
  }
};

const drainEvents = async ({
  supabaseClient,
  sanityClient,
  summary,
  eventLimit,
  deadline,
  preferredIds,
}) => {
  const seenEventKeys = new Set();
  for (let index = 0; index < eventLimit; index += 1) {
    if (Date.now() >= deadline) {
      summary.budgetExhausted = true;
      break;
    }
    if (preferredIds.length > 0) {
      const required = await readRequiredStatus({
        supabaseClient,
        requiredDocumentIds: preferredIds,
      });
      if (
        Number(required?.pending ?? 1) === 0 ||
        Number(required?.dead_letters ?? 0) > 0
      ) {
        break;
      }
    }
    const leaseId = crypto.randomUUID();
    const events = await claimBatch({
      supabaseClient,
      leaseId,
      limit: 1,
      preferredIds,
    });
    if (!Array.isArray(events) || events.length < 1) break;
    const event = events[0];
    const eventKey = String(event?.event_key || "");
    if (seenEventKeys.has(eventKey)) break;
    seenEventKeys.add(eventKey);
    const failuresBefore = summary.retried + summary.deadLettered;
    await processEvent({ supabaseClient, sanityClient, event, leaseId, summary });
    if (summary.retried + summary.deadLettered > failuresBefore) break;
  }
};

export const drainDocumentMutationOutbox = async ({
  supabaseClient,
  sanityClient,
  requiredDocumentIds = [],
  limit = 25,
  maxBatches = 4,
  budgetMs = 30_000,
} = {}) => {
  if (!supabaseClient?.rpc || !sanityClient?.transaction) {
    return { ...emptySummary(), supported: false };
  }
  const summary = emptySummary();
  const batchLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const batchCount = Math.max(1, Math.min(20, Number(maxBatches) || 4));
  const eventLimit = Math.min(100, batchLimit * batchCount);
  const budget = Math.max(1_000, Math.min(60_000, Number(budgetMs) || 30_000));
  const requiredIds = normalizeIds(requiredDocumentIds);

  try {
    await drainEvents({
      supabaseClient,
      sanityClient,
      summary,
      eventLimit,
      deadline: Date.now() + budget,
      preferredIds: requiredIds,
    });
  } catch (error) {
    if (isMissingRpc(error)) return { ...summary, supported: false };
    logSafeError("Document mirror outbox claim failed", error);
    logSanityMirrorEvent({
      event: "sanity_mirror_lag",
      reason: "outbox_unavailable",
      domain: "global",
    });
    return { ...summary, pending: true, errorCode: getSafeErrorCode(error) };
  }

  try {
    return { ...summary, ...(await readBacklog({
      supabaseClient,
      requiredDocumentIds: requiredIds,
    })) };
  } catch (error) {
    logSafeError("Document mirror backlog check failed", error);
    logSanityMirrorEvent({
      event: "sanity_mirror_lag",
      reason: "backlog_unavailable",
      domain: "global",
    });
    return { ...summary, pending: true, errorCode: getSafeErrorCode(error) };
  }
};
