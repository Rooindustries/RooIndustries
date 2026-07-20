import {
  isReferralCommerceField,
  pickReferralGeneralFields,
} from "../commerce/documentTypes.js";
import { logSafeError } from "../safeErrorLog.js";
import {
  buildMirrorEvent,
  listReverseMirrorFailures,
  recordMirrorFailure,
  resolveMirrorFailure,
} from "./mirrorRecovery.js";
import { drainCommerceMirrorOutbox } from "./commerceMirrorOutbox.js";
import { drainDocumentMutationOutbox } from "./documentMutationOutbox.js";
import {
  hasDurableMirrorMarker,
  MIRROR_METADATA_KEYS,
} from "./mirrorMetadata.js";
import { logSanityMirrorEvent } from "./mirrorObservability.js";

const legacyExcludedKeys = new Set([
  "_rev",
  "_createdAt",
  "_updatedAt",
  "_originalId",
  "_system",
  "_commerceCutoverGeneration",
  ...MIRROR_METADATA_KEYS,
]);

const cleanForSanity = (document) => {
  if (!document || typeof document !== "object") return document;
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => !legacyExcludedKeys.has(key))
  );
};

const listLegacyEligibleIds = async ({ sanityClient, ids }) => {
  if (typeof sanityClient?.fetch !== "function") {
    throw new Error("Sanity mirror reads are unavailable.");
  }
  const current = await sanityClient.fetch(
    `*[_id in $ids]`,
    { ids },
    { perspective: "raw" }
  );
  const currentById = new Map(
    (Array.isArray(current) ? current : [])
      .filter((document) => document?._id)
      .map((document) => [String(document._id), document])
  );
  const eligibleIds = ids.filter(
    (id) => !hasDurableMirrorMarker(currentById.get(id))
  );
  return { eligibleIds, currentById };
};

const immutableSanityKeys = new Set([
  "_id",
  "_type",
  "_rev",
  "_createdAt",
  "_updatedAt",
  "_originalId",
  "_system",
  "_commerceCutoverGeneration",
  ...MIRROR_METADATA_KEYS,
]);

const applyLegacyReferral = ({ transaction, current, document }) => {
  if (!current) return transaction.createIfNotExists(cleanForSanity(document));
  const set = pickReferralGeneralFields(cleanForSanity(document));
  delete set._id;
  delete set._type;
  const unset = Object.keys(current).filter(
    (key) =>
      !immutableSanityKeys.has(key) &&
      !isReferralCommerceField(key) &&
      key !== "_commerceCutoverGeneration" &&
      !Object.prototype.hasOwnProperty.call(set, key)
  );
  return transaction.patch(document._id, (patch) => {
    const guarded =
      current._rev && typeof patch.ifRevisionId === "function"
        ? patch.ifRevisionId(current._rev)
        : patch;
    const setPatch = guarded.set(set);
    return unset.length > 0 ? setPatch.unset(unset) : setPatch;
  });
};

const applyMirror = async ({ supabaseClient, sanityClient, ids, deleted }) => {
  const uniqueIds = [...new Set((ids || []).map(String).filter(Boolean))];
  if (uniqueIds.length < 1) return;
  const eligible = await listLegacyEligibleIds({ sanityClient, ids: uniqueIds });
  if (eligible.eligibleIds.length < 1) return;

  if (deleted) {
    let transaction = sanityClient.transaction();
    eligible.eligibleIds.forEach((id) => {
      transaction = transaction.delete(id);
    });
    await transaction.commit();
    return;
  }

  const documents = await supabaseClient.fetch(`*[_id in $ids]`, {
    ids: eligible.eligibleIds,
  });
  const byId = new Map(
    (documents || []).map((document) => [String(document?._id || ""), document])
  );
  let transaction = sanityClient.transaction();
  for (const id of eligible.eligibleIds) {
    const document = byId.get(id);
    const current = eligible.currentById.get(id);
    if (!document) transaction = transaction.delete(id);
    else if (document._type === "referral") {
      transaction = applyLegacyReferral({ transaction, current, document });
    } else transaction = transaction.createOrReplace(cleanForSanity(document));
  }
  await transaction.commit();
};

const mirrorIds = async ({
  supabaseClient,
  sanityClient,
  recoveryClient,
  ids,
  deleted = false,
}) => {
  const operation = deleted
    ? "supabase_to_sanity_delete"
    : "supabase_to_sanity_upsert";
  const event = buildMirrorEvent({ operation, ids });
  if (event.ids.length < 1) return { mirrored: 0, queued: false };

  try {
    await applyMirror({
      supabaseClient,
      sanityClient,
      ids: event.ids,
      deleted,
    });
    if (recoveryClient) {
      try {
        await resolveMirrorFailure({
          client: recoveryClient,
          eventKey: event.eventKey,
        });
      } catch (error) {
        logSafeError("Reverse mirror recovery resolution failed", error);
      }
    }
    return { mirrored: event.ids.length, queued: false };
  } catch (error) {
    logSafeError("Sanity reverse mirror failed", error);
    logSanityMirrorEvent({
      event: "sanity_mirror_lag",
      reason: "delivery_failed",
      domain: supabaseClient?.commerceOnly === true ? "commerce" : "global",
    });
    try {
      await recordMirrorFailure({
        client: recoveryClient,
        eventKey: event.eventKey,
        operation,
        ids: event.ids,
        error,
      });
      return { mirrored: 0, queued: true };
    } catch (queueError) {
      logSafeError("Reverse mirror recovery queue failed", queueError);
      logSanityMirrorEvent({
        event: "sanity_mirror_lag",
        reason: "recovery_queue_unavailable",
      });
      return { mirrored: 0, queued: false };
    }
  }
};

export const retryReverseMirrorFailures = async ({
  supabaseClient,
  sanityClient,
  recoveryClient,
  limit = 25,
} = {}) => {
  const pending = await listReverseMirrorFailures({
    client: recoveryClient,
    limit,
  });
  const summary = { attempted: pending.length, mirrored: 0, queued: 0 };
  for (const entry of pending) {
    const result = await mirrorIds({
      supabaseClient,
      sanityClient,
      recoveryClient,
      ids: Array.isArray(entry?.ids) ? entry.ids : [],
      deleted: entry?.operation === "supabase_to_sanity_delete",
    });
    summary.mirrored += Number(result.mirrored || 0);
    summary.queued += result.queued ? 1 : 0;
  }
  return summary;
};

const wrapPatch = ({ patch, id, onCommitted, allowDeferred = false }) => {
  const wrapper = {};
  for (const method of ["set", "setIfMissing", "unset", "inc", "dec", "ifRevisionId"]) {
    wrapper[method] = (...args) => {
      patch = patch[method](...args);
      return wrapper;
    };
  }
  wrapper.commit = async (...args) => {
    const result = await patch.commit(...args);
    const deferMirror = allowDeferred && args[0]?.deferMirror === true;
    if (!deferMirror) await onCommitted([id]);
    return result;
  };
  return wrapper;
};

const wrapTransaction = ({ transaction, onCommitted, onDeleted }) => {
  const changedIds = new Set();
  const deletedIds = new Set();
  const wrapper = {};
  wrapper.create = (document) => {
    changedIds.add(document?._id);
    transaction = transaction.create(document);
    return wrapper;
  };
  wrapper.createIfNotExists = (document) => {
    changedIds.add(document?._id);
    transaction = transaction.createIfNotExists(document);
    return wrapper;
  };
  wrapper.createOrReplace = (document) => {
    changedIds.add(document?._id);
    transaction = transaction.createOrReplace(document);
    return wrapper;
  };
  wrapper.patch = (id, patcher) => {
    changedIds.add(id);
    transaction = transaction.patch(id, patcher);
    return wrapper;
  };
  wrapper.delete = (id, options) => {
    deletedIds.add(id);
    transaction = transaction.delete(id, options);
    return wrapper;
  };
  wrapper.commit = async (...args) => {
    const result = await transaction.commit(...args);
    await onCommitted([...changedIds]);
    await onDeleted([...deletedIds]);
    return result;
  };
  return wrapper;
};

export const createReverseMirroringSupabaseClient = ({
  supabaseClient,
  sanityClient,
  recoveryClient = supabaseClient?.shadowClient || null,
} = {}) => {
  if (!supabaseClient || !sanityClient) {
    throw new Error("Both document backends are required for reverse mirroring.");
  }
  const domain = supabaseClient.commerceOnly === true ? "commerce" : "global";
  const drainOrFallback = async ({ ids, deleted = false, ...options }) => {
    try {
      if (supabaseClient.commerceOnly === true) {
        return await drainCommerceMirrorOutbox({
          supabaseClient: recoveryClient,
          sanityClient,
          requiredDocumentIds: ids,
          ...options,
        });
      }
      const drained = await drainDocumentMutationOutbox({
        supabaseClient: recoveryClient,
        sanityClient,
        requiredDocumentIds: ids,
        limit: 10,
        maxBatches: 2,
        budgetMs: 5_000,
      });
      if (drained.supported) return drained;
      return mirrorIds({
        supabaseClient,
        sanityClient,
        recoveryClient,
        ids,
        deleted,
      });
    } catch (error) {
      logSafeError("Sanity mirror delivery failed", error);
      logSanityMirrorEvent({
        event: "sanity_mirror_lag",
        reason: "delivery_failed",
        domain,
      });
      return { supported: true, mirrored: 0, queued: true, pending: true };
    }
  };
  const onCommitted = async () => ({ deferred: true });
  const onDeleted = async () => ({ deferred: true });

  return new Proxy(supabaseClient, {
    get(target, property) {
      if (property === "reconcileReverseMirror") {
        return async (options = {}) => {
          const outbox =
            target.commerceOnly === true
              ? await drainCommerceMirrorOutbox({
                  supabaseClient: recoveryClient,
                  sanityClient,
                  ...options,
                })
              : await drainDocumentMutationOutbox({
                  supabaseClient: recoveryClient,
                  sanityClient,
                  ...options,
                });
          const legacy = target.commerceOnly === true
            ? { attempted: 0, mirrored: 0, queued: 0, supersededByOutbox: true }
            : await retryReverseMirrorFailures({
                supabaseClient: target,
                sanityClient,
                recoveryClient,
                ...options,
              });
          return { outbox, legacy };
        };
      }
      if (property === "flushCommerceMirror") {
        return (options = {}) => {
          if (target.commerceOnly !== true) {
            return Promise.resolve({
              supported: false,
              attempted: 0,
              mirrored: 0,
              failed: 0,
            });
          }
          const {
            requiredDocumentIds: ids = [],
            limit,
            maxBatches,
          } = options;
          return drainOrFallback({
            ids,
            deleted: false,
            ...(limit === undefined ? {} : { limit }),
            ...(maxBatches === undefined ? {} : { maxBatches }),
          });
        };
      }
      if (["create", "createIfNotExists", "createOrReplace"].includes(property)) {
        return async (document, ...args) => {
          const result = await target[property](document, ...args);
          const deferMirror =
            target.commerceOnly === true && args[0]?.deferMirror === true;
          if (!deferMirror) await onCommitted([document?._id || result?._id]);
          return result;
        };
      }
      if (property === "patch") {
        return (id) =>
          wrapPatch({
            patch: target.patch(id),
            id,
            onCommitted,
            allowDeferred: target.commerceOnly === true,
          });
      }
      if (property === "transaction") {
        return () =>
          wrapTransaction({
            transaction: target.transaction(),
            onCommitted,
            onDeleted,
          });
      }
      if (property === "delete") {
        return async (deleteTarget, ...args) => {
          let ids = [];
          if (typeof deleteTarget === "string") {
            ids = [deleteTarget];
          } else if (deleteTarget?.query) {
            const matches = await target.fetch(
              deleteTarget.query,
              deleteTarget.params || {}
            );
            ids = (Array.isArray(matches) ? matches : [matches])
              .map((item) => (typeof item === "string" ? item : item?._id))
              .filter(Boolean);
          }
          const result = await target.delete(deleteTarget, ...args);
          await onDeleted(ids);
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
