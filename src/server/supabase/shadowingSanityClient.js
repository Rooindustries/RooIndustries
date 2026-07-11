import { logSafeError } from "../safeErrorLog.js";
import { createSupabaseAdminClient } from "./adminClient.js";
import {
  buildMirrorEvent,
  recordMirrorFailure,
  resolveMirrorFailure,
} from "./mirrorRecovery.js";
import {
  importCommerceShadowDocuments,
  importShadowDocuments,
  projectReferralAccountShadow,
  projectOperationalShadow,
  tombstoneCommerceShadowDocuments,
  tombstoneShadowDocuments,
} from "./shadowStore.js";

const normalizeId = (value) => String(value || "").trim();

const mirrorDocuments = async ({
  sanityClient,
  ids,
  shadowClient,
  commerceOnly = false,
}) => {
  const uniqueIds = [...new Set(ids.map(normalizeId).filter(Boolean))];
  if (uniqueIds.length < 1) return;
  const operation = "sanity_to_supabase_sync";
  const event = buildMirrorEvent({ operation, ids: uniqueIds });

  try {
    const sourceDocuments = await sanityClient.fetch(`*[_id in $ids]`, {
      ids: uniqueIds,
    });
    const found = new Set((sourceDocuments || []).map((document) => document._id));
    const importer = commerceOnly
      ? importCommerceShadowDocuments
      : importShadowDocuments;
    await importer({ documents: sourceDocuments || [], client: shadowClient });

    const missingIds = uniqueIds.filter((id) => !found.has(id));
    if (missingIds.length > 0) {
      const tombstone = commerceOnly
        ? tombstoneCommerceShadowDocuments
        : tombstoneShadowDocuments;
      await tombstone({ ids: missingIds, client: shadowClient });
    }
    if (!commerceOnly) {
      const referralIds = (sourceDocuments || [])
        .filter((document) => document?._type === "referral")
        .map((document) => document._id);
      if (referralIds.length > 0) {
        await projectReferralAccountShadow({
          ids: referralIds,
          client: shadowClient,
        });
      }
      await projectOperationalShadow({ client: shadowClient });
    }
    await resolveMirrorFailure({
      client: shadowClient,
      eventKey: event.eventKey,
    });
  } catch (error) {
    logSafeError("Supabase shadow mirror failed", error);
    try {
      await recordMirrorFailure({
        client: shadowClient,
        eventKey: event.eventKey,
        operation,
        ids: event.ids,
        error,
      });
    } catch (queueError) {
      logSafeError("Supabase shadow recovery queue failed", queueError);
    }
  }
};

const wrapPatch = ({ patch, id, onCommitted }) => {
  const wrapper = {};
  for (const method of ["set", "setIfMissing", "unset", "inc", "dec", "ifRevisionId"]) {
    wrapper[method] = (...args) => {
      patch = patch[method](...args);
      return wrapper;
    };
  }
  wrapper.commit = async (...args) => {
    const result = await patch.commit(...args);
    await onCommitted([id]);
    return result;
  };
  return wrapper;
};

const wrapTransaction = ({ transaction, onCommitted }) => {
  const ids = new Set();
  const wrapper = {};

  wrapper.create = (document) => {
    ids.add(document?._id);
    transaction = transaction.create(document);
    return wrapper;
  };
  wrapper.createIfNotExists = (document) => {
    ids.add(document?._id);
    transaction = transaction.createIfNotExists(document);
    return wrapper;
  };
  wrapper.createOrReplace = (document) => {
    ids.add(document?._id);
    transaction = transaction.createOrReplace(document);
    return wrapper;
  };
  wrapper.patch = (id, patcher) => {
    ids.add(id);
    transaction = transaction.patch(id, patcher);
    return wrapper;
  };
  wrapper.delete = (id) => {
    ids.add(id);
    transaction = transaction.delete(id);
    return wrapper;
  };
  wrapper.commit = async (...args) => {
    const result = await transaction.commit(...args);
    await onCommitted([...ids]);
    return result;
  };
  return wrapper;
};

export const createShadowingSanityClient = ({
  sanityClient,
  shadowClient = createSupabaseAdminClient(),
  commerceOnly = false,
} = {}) => {
  if (!sanityClient) throw new Error("A Sanity client is required.");
  const onCommitted = (ids) =>
    mirrorDocuments({ sanityClient, ids, shadowClient, commerceOnly });

  return new Proxy(sanityClient, {
    get(target, property) {
      if (property === "create" || property === "createIfNotExists" || property === "createOrReplace") {
        return async (document, ...args) => {
          const result = await target[property](document, ...args);
          await onCommitted([document?._id || result?._id]);
          return result;
        };
      }
      if (property === "patch") {
        return (id) => wrapPatch({
          patch: target.patch(id),
          id,
          onCommitted,
        });
      }
      if (property === "transaction") {
        return () => wrapTransaction({
          transaction: target.transaction(),
          onCommitted,
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
          await onCommitted(ids);
          return result;
        };
      }

      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
