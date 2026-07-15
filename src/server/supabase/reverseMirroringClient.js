import { logSafeError } from "../safeErrorLog.js";
import {
  buildMirrorEvent,
  listReverseMirrorFailures,
  recordMirrorFailure,
  resolveMirrorFailure,
} from "./mirrorRecovery.js";
import { drainCommerceMirrorOutbox } from "./commerceMirrorOutbox.js";
import { drainDocumentMutationOutbox } from "./documentMutationOutbox.js";

const cleanForSanity = (document) => {
  if (!document || typeof document !== "object") return document;
  const { _rev, _createdAt, _updatedAt, ...clean } = document;
  return clean;
};

const hasDurableMirrorMarker = (document) => {
  const sequence = String(document?._supabaseSequence ?? "").trim();
  return /^\d+$/.test(sequence) && BigInt(sequence) > 0n;
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
  const protectedIds = new Set(
    (Array.isArray(current) ? current : [])
      .filter(hasDurableMirrorMarker)
      .map((document) => String(document?._id || ""))
  );
  return ids.filter((id) => !protectedIds.has(id));
};

const applyMirror = async ({ supabaseClient, sanityClient, ids, deleted }) => {
  const uniqueIds = [...new Set((ids || []).map(String).filter(Boolean))];
  if (uniqueIds.length < 1) return;
  const eligibleIds = await listLegacyEligibleIds({ sanityClient, ids: uniqueIds });
  if (eligibleIds.length < 1) return;

  if (deleted) {
    let transaction = sanityClient.transaction();
    eligibleIds.forEach((id) => {
      transaction = transaction.delete(id);
    });
    await transaction.commit();
    return;
  }

  const documents = await supabaseClient.fetch(`*[_id in $ids]`, {
    ids: eligibleIds,
  });
  const byId = new Map(
    (documents || []).map((document) => [String(document?._id || ""), document])
  );
  let transaction = sanityClient.transaction();
  for (const id of eligibleIds) {
    const document = byId.get(id);
    transaction = document
      ? transaction.createOrReplace(cleanForSanity(document))
      : transaction.delete(id);
  }
  await transaction.commit();
};

const mirrorIds = async ({
  supabaseClient,
  sanityClient,
  recoveryClient,
  ids,
  deleted = false,
  failClosed = true,
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
      if (failClosed) {
        const failure = new Error(
          "The primary write completed, but its rollback mirror could not be queued."
        );
        failure.code = "REVERSE_MIRROR_UNRECORDED";
        failure.cause = queueError;
        throw failure;
      }
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
      failClosed: false,
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
  const drainOrFallback = async ({ ids, deleted = false, failClosed = false }) => {
    if (supabaseClient.commerceOnly === true) {
      const drained = await drainCommerceMirrorOutbox({
        supabaseClient: recoveryClient,
        sanityClient,
        failClosed,
        requiredDocumentIds: failClosed ? ids : [],
      });
      return drained;
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
      failClosed,
    });
  };
  const onCommitted = (ids) =>
    drainOrFallback({
      ids,
      deleted: false,
      failClosed: supabaseClient.commerceOnly !== true,
    });
  const onDeleted = (ids) =>
    drainOrFallback({
      ids,
      deleted: true,
      failClosed: supabaseClient.commerceOnly !== true,
    });

  return new Proxy(supabaseClient, {
    get(target, property) {
      if (property === "reconcileReverseMirror") {
        return async (options = {}) => {
          const outbox =
            target.commerceOnly === true
              ? await drainCommerceMirrorOutbox({
                  supabaseClient: recoveryClient,
                  sanityClient,
                  failClosed: false,
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
        return ({ failClosed = true, ...options } = {}) =>
          target.commerceOnly === true
            ? drainCommerceMirrorOutbox({
                supabaseClient: recoveryClient,
                sanityClient,
                failClosed,
                ...options,
              })
            : Promise.resolve({
                supported: false,
                attempted: 0,
                mirrored: 0,
                failed: 0,
              });
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
