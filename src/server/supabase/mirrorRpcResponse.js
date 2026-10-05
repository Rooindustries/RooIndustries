const invalid = () => {
  const error = new Error("Mirror RPC returned an invalid response.");
  error.code = "MIRROR_RPC_RESPONSE_INVALID";
  error.status = 503;
  error.statusCode = 503;
  return error;
};

export const requireMirrorStatus = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(value.pending) || value.pending < 0 ||
      !Number.isSafeInteger(value.dead_letters) || value.dead_letters < 0 ||
      value.dead_letters > value.pending) throw invalid();
  for (const key of ["actionable", "processing", "retry", "overdue", "expired_leases"]) {
    if (Object.prototype.hasOwnProperty.call(value, key) &&
        (!Number.isSafeInteger(value[key]) || value[key] < 0 ||
          value[key] > value.pending)) throw invalid();
  }
  if (value.actionable !== undefined && value.processing !== undefined &&
      value.actionable + value.processing + value.dead_letters !== value.pending) {
    throw invalid();
  }
  if (value.expired_leases !== undefined && value.processing !== undefined &&
      value.expired_leases > value.processing) throw invalid();
  return value;
};

export const requireMirrorEvents = (events, domain) => {
  if (!Array.isArray(events)) throw invalid();
  for (const event of events) {
    const deleted = domain === "commerce" ? event?.deleted_ids : event?.deleted_documents;
    if (typeof event?.event_key !== "string" || !event.event_key ||
        !/^[1-9][0-9]*$/.test(String(event?.sequence_no)) ||
        (typeof event.sequence_no === "number" && !Number.isSafeInteger(event.sequence_no)) ||
        !Array.isArray(event.document_ids) || event.document_ids.length < 1 ||
        !Array.isArray(event.documents) || !Array.isArray(deleted)) throw invalid();
    const ids = [...event.documents.map((document) => document?._id),
      ...deleted.map((document) => domain === "commerce" ? document : document?._id)];
    if (ids.some((id) => typeof id !== "string" || !id) ||
        event.document_ids.some((id) => typeof id !== "string" || !ids.includes(id)) ||
        ids.some((id) => !event.document_ids.includes(id)) ||
        new Set(event.documents.map((document) => document?._id)).size !== event.documents.length ||
        new Set(deleted.map((document) => domain === "commerce" ? document : document?._id)).size !== deleted.length) throw invalid();
  }
  return events;
};

export const requireMirrorCompletion = ({ value, eventKey, statuses }) => {
  if (value?.event_key !== eventKey ||
      !(statuses.includes(value?.status) ||
        (value?.status === undefined && statuses.includes("mirrored") &&
          value?.mirrored === true))) throw invalid();
  return value;
};
