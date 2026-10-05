const immutableKeys = new Set([
  "_id", "_type", "_rev", "_createdAt", "_updatedAt", "_originalId", "_system",
]);

export const requireSanityMirrorRevision = (current) => {
  if (typeof current?._rev !== "string" || !current._rev.trim()) {
    const error = new Error("Sanity mirror revision is unavailable.");
    error.code = "SANITY_MIRROR_REVISION_UNAVAILABLE";
    error.status = 409;
    error.statusCode = 409;
    throw error;
  }
  return current._rev;
};

export const appendSanityMirrorUpsert = ({ transaction, current, document }) => {
  if (!current) return transaction.createIfNotExists(document);
  if (current._type !== document._type) {
    return appendSanityMirrorDelete({ transaction, id: document._id, current })
      .create(document);
  }
  const revision = requireSanityMirrorRevision(current);
  const set = Object.fromEntries(Object.entries(document)
    .filter(([key]) => !immutableKeys.has(key)));
  const unset = Object.keys(current).filter((key) =>
    !immutableKeys.has(key) && !Object.prototype.hasOwnProperty.call(set, key));
  return transaction.patch(document._id, (patch) => {
    const guarded = patch.ifRevisionId(revision).set(set);
    return unset.length > 0 ? guarded.unset(unset) : guarded;
  });
};

export const appendSanityMirrorDelete = ({ transaction, id, current }) => {
  if (!current) return transaction;
  return transaction.patch(id, (patch) => patch
    .ifRevisionId(requireSanityMirrorRevision(current))
    .set({ _supabaseRevision: current._supabaseRevision || current._rev }))
    .delete(id);
};
