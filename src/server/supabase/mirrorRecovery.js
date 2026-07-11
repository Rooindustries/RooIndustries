import crypto from "node:crypto";

const normalizeIds = (ids = []) =>
  [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))].sort();

const requireRpc = ({ error }, operation) => {
  if (!error) return;
  const failure = new Error(`Supabase ${operation} failed.`);
  failure.code = error.code || "SUPABASE_MIRROR_RECOVERY_FAILED";
  throw failure;
};

export const buildMirrorEvent = ({ operation, ids = [] } = {}) => {
  const normalizedIds = normalizeIds(ids);
  const eventKey = `mirror:${crypto
    .createHash("sha256")
    .update(`${String(operation || "").trim()}:${normalizedIds.join("\n")}`)
    .digest("hex")}`;
  return { eventKey, ids: normalizedIds };
};

export const recordMirrorFailure = async ({
  client,
  eventKey,
  operation,
  ids,
  error,
} = {}) => {
  if (!client?.rpc) throw new Error("Mirror recovery storage is unavailable.");
  const result = await client.rpc("roo_record_mirror_failure", {
    p_event_key: eventKey,
    p_operation: operation,
    p_ids: normalizeIds(ids),
    p_error_code: String(error?.code || error?.name || "MIRROR_FAILED").slice(0, 128),
  });
  requireRpc(result, "mirror failure queue");
  return result.data || null;
};

export const resolveMirrorFailure = async ({ client, eventKey } = {}) => {
  if (!client?.rpc) return null;
  const result = await client.rpc("roo_resolve_mirror_failure", {
    p_event_key: eventKey,
  });
  requireRpc(result, "mirror failure resolution");
  return result.data || null;
};

export const listReverseMirrorFailures = async ({ client, limit = 25 } = {}) => {
  if (!client?.rpc) return [];
  const result = await client.rpc("roo_list_reverse_mirror_failures", {
    p_limit: Math.max(1, Math.min(100, Number(limit) || 25)),
  });
  requireRpc(result, "reverse mirror recovery list");
  return Array.isArray(result.data) ? result.data : [];
};
