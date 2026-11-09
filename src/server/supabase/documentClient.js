import crypto from "node:crypto";
import {logSafeError} from "../safeErrorLog.js";
import { evaluate, parse } from "groq-js";
import { isBookingBlockingStatus } from "../booking/bookingStatus.js";
import {
  applyShadowMutations,
  fetchCommerceAvailability,
  fetchCommerceDerivedCount,
  fetchReferralEarningsSummary,
  fetchRecoveryPaymentIds,
  referralSyncCursor,
  fetchShadowDocumentSizes,
  fetchUpgradeBookingChain,
} from "./shadowStore.js";
import {fetchShadowDocuments} from "./readShadowDocuments.js";

const clone = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const splitPath = (path) =>
  String(path || "")
    .replace(/\[([0-9]+)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

const readPath = (object, path) =>
  splitPath(path).reduce(
    (value, part) => (value === undefined || value === null ? undefined : value[part]),
    object
  );

const MAX_COMMERCE_PAYLOAD_BYTES = 250 * 1024;
const BATCH_PLANNING_BYTES = MAX_COMMERCE_PAYLOAD_BYTES * 0.8;

const payloadBudgetError = () => Object.assign(
  new Error("Commerce query exceeded its database payload budget."),
  {code: "COMMERCE_PAYLOAD_BUDGET_EXCEEDED", status: 503, statusCode: 503}
);

const uniqueStrings = (values = []) =>
  [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];

const inferLiteralTypes = (query) => {
  const types = [];
  for (const match of String(query || "").matchAll(/_type\s*==\s*["']([^"']+)["']/g)) {
    types.push(match[1]);
  }
  for (const match of String(query || "").matchAll(/_type\s+in\s+\[([^\]]+)\]/g)) {
    for (const quoted of match[1].matchAll(/["']([^"']+)["']/g)) {
      types.push(quoted[1]);
    }
  }
  return uniqueStrings(types);
};

const inferQueryLimit = (query) => {
  const slice = String(query || "").match(/\[\s*0\s*\.\.\.\s*([0-9]+)\s*\]/);
  if (slice) return Math.max(1, Math.min(1000, Number(slice[1]) || 500));
  return /\]\s*\[\s*0\s*\]/.test(String(query || "")) ? 1 : 500;
};

// When a query carries predicates that were not pushed down to the shadow
// store (joins, ORs, literals), the local GROQ evaluator applies them — so
// truncating the database read to the inferred limit could drop the matching
// rows before evaluation. Only push the limit down alongside pushed filters.
const hasUnpushedPredicates = ({ source, ids, filters }) => {
  if (ids.length > 0 || filters.length > 0) return false;
  const head = String(source || "").split("]")[0] || "";
  const stripped = head
    .replace(/_type\s*==\s*["'][^"']*["']/g, "")
    .replace(/_type\s+in\s+\[[^\]]*\]/g, "")
    .replace(/_id\s*==\s*(?:\$[A-Za-z_][A-Za-z0-9_]*|"[^"]*"|'[^']*')/g, "")
    .replace(/_id\s+in\s+(?:\$[A-Za-z_][A-Za-z0-9_]*|\[[^\]]*\])/g, "");
  return /==|!=|<=|>=|<|>|\bin\b/.test(stripped);
};

export const inferShadowScope = ({ query, params = {}, configuredTypes = null }) => {
  const source = String(query || "");
  const literalTypes = inferLiteralTypes(source);
  const paramType = source.match(/_type\s*==\s*\$([A-Za-z_][A-Za-z0-9_]*)/);
  const documentTypes = uniqueStrings([
    ...(literalTypes.length > 0 ? literalTypes : configuredTypes || []),
    ...(paramType && params[paramType[1]] ? [params[paramType[1]]] : []),
    ...(source.includes("->") ? ["package"] : []),
  ]);
  const hasOr = source.includes("||");
  const ids = [];
  if (!hasOr && !source.includes("->")) {
    const idEq = source.match(/_id\s*==\s*\$([A-Za-z_][A-Za-z0-9_]*)/);
    if (idEq && params[idEq[1]]) ids.push(params[idEq[1]]);
    const idIn = source.match(/_id\s+in\s+\$([A-Za-z_][A-Za-z0-9_]*)/);
    if (idIn && Array.isArray(params[idIn[1]])) ids.push(...params[idIn[1]]);
  }

  const filters = [];
  if (!hasOr && !source.includes("->")) {
    const pattern = /(lower\()?([A-Za-z_][A-Za-z0-9_.]*)(?:\))?\s*(==|in|<=|>=|<|>)\s*\$([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const match of source.matchAll(pattern)) {
      const [, lowerCall, path, operator, param] = match;
      if (["_id", "_type"].includes(path) || params[param] === undefined) continue;
      const op =
        operator === "=="
          ? lowerCall
            ? "ieq"
            : "eq"
          : operator === "in"
            ? "in"
            : ({ "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" })[operator];
      filters.push({ path, op, value: params[param] });
    }
  }
  const capped = (source.match(/\*\s*\[/g) || []).length > 1 || source.includes("->") || hasUnpushedPredicates({ source, ids, filters });
  const pinnedIds = [];
  for (const match of source.matchAll(/_id\s*==\s*(?:["']([^"']+)["']|\$([A-Za-z_][A-Za-z0-9_]*))/g)) {
    pinnedIds.push(match[1] || params[match[2]]);
  }
  return {
    documentTypes: documentTypes.length > 0 ? documentTypes : null,
    ids: ids.length ? uniqueStrings(ids) : null,
    filters,
    limit: capped ? 1000 : inferQueryLimit(source),
    capped,
    pinnedIds: uniqueStrings(pinnedIds),
  };
};

const writePath = (object, path, value) => {
  const parts = splitPath(path);
  if (parts.length < 1) return;
  let cursor = object;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = clone(value);
};

const removePath = (object, path) => {
  const parts = splitPath(path);
  if (parts.length < 1) return;
  let cursor = object;
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor = cursor?.[parts[index]];
    if (!cursor || typeof cursor !== "object") return;
  }
  delete cursor[parts.at(-1)];
};

const revisionConflict = () => {
  const error = new Error("Document revision conflict.");
  error.code = "40001";
  error.status = 409;
  error.statusCode = 409;
  return error;
};

const mutationRevision = (expectedRevision, currentRevision) => {
  if (expectedRevision === undefined) return currentRevision || "";
  if (typeof expectedRevision !== "string" || !expectedRevision.trim()) {
    throw revisionConflict();
  }
  return expectedRevision.trim();
};

const deleteRevision = (options) =>
  Object.prototype.hasOwnProperty.call(options || {}, "ifRevisionId")
    ? mutationRevision(options.ifRevisionId ?? null, "")
    : undefined;

class PatchSpec {
  constructor(id) {
    this.id = String(id || "").trim();
    this.expectedRevision = undefined;
    this.operations = [];
  }

  ifRevisionId(revision) {
    this.expectedRevision = typeof revision === "string" ? revision.trim() : "";
    return this;
  }

  set(values) {
    this.operations.push({ type: "set", values: clone(values || {}) });
    return this;
  }

  setIfMissing(values) {
    this.operations.push({ type: "setIfMissing", values: clone(values || {}) });
    return this;
  }

  unset(paths) {
    this.operations.push({ type: "unset", paths: [...(paths || [])] });
    return this;
  }

  inc(values) {
    this.operations.push({ type: "inc", values: clone(values || {}) });
    return this;
  }

  dec(values) {
    this.operations.push({ type: "dec", values: clone(values || {}) });
    return this;
  }
}

const resumeBookingConfirmation = (current, next) => {
  if (current?._type !== "booking" || isBookingBlockingStatus(current.status) ||
      !isBookingBlockingStatus(next.status)) return next;
  if (["delivery_unknown", "historical_unknown"].includes(current.emailDispatchStatus)) return next;
  const unattempted = ["Client", "Owner"].some(recipient =>
    !current[`emailDispatch${recipient}SentAt`] && !current[`emailDispatch${recipient}FirstAttemptAt`]);
  return { ...next,
    ...(unattempted ? { emailDispatchAttemptCount: 0 } : {}),
    ...(current.emailDispatchLastError === "booking_inactive" ? { emailDispatchLastError: "" } : {}),
    emailDispatchNextAttemptAt: "", emailDispatchLeaseId: "", emailDispatchLeaseExpiresAt: "",
  };
};

const applyPatch = (document, patch) => {
  const next = clone(document);
  for (const operation of patch.operations) {
    if (operation.type === "unset") {
      operation.paths.forEach((path) => removePath(next, path));
      continue;
    }
    for (const [path, value] of Object.entries(operation.values || {})) {
      if (operation.type === "setIfMissing" && readPath(next, path) !== undefined) {
        continue;
      }
      if (operation.type === "inc" || operation.type === "dec") {
        const current = Number(readPath(next, path) || 0);
        const delta = Number(value || 0) * (operation.type === "dec" ? -1 : 1);
        writePath(next, path, current + delta);
        continue;
      }
      writePath(next, path, value);
    }
  }
  return resumeBookingConfirmation(document, next);
};

class PatchBuilder extends PatchSpec {
  constructor(client, id) {
    super(id);
    this.client = client;
    this.commandId = `commerce:${crypto.randomUUID()}`;
  }

  commit(options = {}) {
    return this.client.commitPatch(this, {
      ...options,
      commandId: options.commandId || this.commandId,
    });
  }
}

class TransactionBuilder {
  constructor(client) {
    this.client = client;
    this.operations = [];
    this.commandId = `commerce:${crypto.randomUUID()}`;
  }

  create(document) {
    this.operations.push({ type: "create", document: clone(document) });
    return this;
  }

  createIfNotExists(document) {
    this.operations.push({ type: "createIfNotExists", document: clone(document) });
    return this;
  }

  createOrReplace(document) {
    this.operations.push({ type: "createOrReplace", document: clone(document) });
    return this;
  }

  patch(id, patcher) {
    const patch = new PatchSpec(id);
    const configured =
      typeof patcher === "function" ? patcher(patch) || patch : patch.set(patcher);
    this.operations.push({ type: "patch", patch: configured });
    return this;
  }

  delete(id, options = {}) {
    this.operations.push({
      type: "delete",
      id: String(id || "").trim(),
      expectedRevision: deleteRevision(options),
    });
    return this;
  }

  commit(options = {}) {
    return this.client.commitTransaction(this.operations, {
      ...options,
      commandId: options.commandId || this.commandId,
    });
  }
}

export class SupabaseDocumentClient {
  constructor({
    shadowClient,
    documentTypes = null,
    commerceOnly = false,
    allowLegacyFallback,
    cutoverGeneration = 0,
    readDocuments = fetchShadowDocuments,
    batchReads = false,
  } = {}) {
    this.shadowClient = shadowClient;
    this.readDocuments = readDocuments;
    this.batchReads = batchReads;
    this.backend = "supabase";
    this.commerceOnly = commerceOnly === true;
    this.allowLegacyFallback =
      allowLegacyFallback === undefined
        ? !this.commerceOnly
        : allowLegacyFallback === true;
    this.cutoverGeneration = Math.max(0, Number(cutoverGeneration) || 0);
    this.documentTypes =
      Array.isArray(documentTypes) && documentTypes.length > 0
        ? [...new Set(documentTypes)]
        : null;
  }

  async dataset(scope = {}) {
    if (Array.isArray(scope.ids) && !scope.ids.length) return [];
    const hasTargetedScope =
      (Array.isArray(scope.documentTypes || this.documentTypes) &&
        (scope.documentTypes || this.documentTypes).length > 0) ||
      (Array.isArray(scope.ids) && scope.ids.length > 0) ||
      (Array.isArray(scope.filters) && scope.filters.length > 0);
    if (this.commerceOnly && !hasTargetedScope) {
      const error = new Error("Commerce queries require a targeted scope.");
      error.code = "COMMERCE_QUERY_SCOPE_REQUIRED";
      error.status = 503;
      error.statusCode = 503;
      throw error;
    }
    const readScope = { ...scope, documentTypes: scope.documentTypes || this.documentTypes };
    let documents;
    if ((this.readDocuments !== fetchShadowDocuments && !this.batchReads) || scope.limit === 1) {
      documents = await this.readDocuments({
        ...readScope, client: this.shadowClient, allowLegacyFallback: this.allowLegacyFallback,
      });
      if (this.commerceOnly && Buffer.byteLength(JSON.stringify(documents)) > MAX_COMMERCE_PAYLOAD_BYTES) {
        throw payloadBudgetError();
      }
    } else {
      documents = [];
      for await (const outcome of this.documentBatches(readScope)) {
        if (outcome.status === "document") documents.push(outcome.document);
        else if (outcome.status === "oversized" || outcome.listed || scope.requireAll) throw outcome.error;
      }
    }
    if (scope.capped && documents.length >= scope.limit) {
      console.error("Shadow document read hit its cap; results may be incomplete. Owner attention is required.", { code: "SHADOW_READ_CAPPED", documentTypes: scope.documentTypes, limit: scope.limit });
    }
    if (scope.capped && scope.pinnedIds.length) {
      const pinned = await this.dataset({documentTypes: readScope.documentTypes, ids: scope.pinnedIds});
      documents = [...new Map([...documents, ...pinned].map(document => [document._id, document])).values()];
    }
    return documents;
  }

  async *documentBatches({documentTypes = this.documentTypes, ids, filters = [], limit = Infinity,
    afterId = null} = {}) {
    if (this.commerceOnly && !documentTypes?.length && !ids?.length && !filters.length) {
      throw Object.assign(new Error("Commerce queries require a targeted scope."),
        {code: "COMMERCE_QUERY_SCOPE_REQUIRED", status: 503, statusCode: 503});
    }
    const requestedIds = Array.isArray(ids) ? uniqueStrings(ids) : null;
    const documentType = documentTypes?.length === 1 ? documentTypes[0] : "other";
    const seen = new Set();
    const missingError = (id) => Object.assign(new Error("Shadow document is missing."),
      {code: "SHADOW_DOCUMENTS_MISSING", status: 503, id, documentType});
    const readBatch = async function* (rows, client) {
      const requested = rows.map(row => row._id);
      let documents;
      try {
        documents = await client.readDocuments({client: client.shadowClient, documentTypes,
          ids: requested, limit: requested.length, allowLegacyFallback: client.allowLegacyFallback});
        const bytes = Buffer.byteLength(JSON.stringify(documents));
        if (bytes > MAX_COMMERCE_PAYLOAD_BYTES) throw Object.assign(payloadBudgetError(), {bytes});
      } catch (error) {
        if (error.code !== "COMMERCE_PAYLOAD_BUDGET_EXCEEDED") throw error;
        if (rows.length > 1) {
          const middle = Math.ceil(rows.length / 2);
          yield* readBatch(rows.slice(0, middle), client);
          yield* readBatch(rows.slice(middle), client);
          return;
        }
        error.id = requested[0];
        error.documentType = documentType;
        logSafeError("Shadow document batch failed", error);
        yield {id: requested[0], status: "oversized", bytes: error.bytes, error};
        return;
      }
      const byId = new Map(documents.map(document => [document._id, document]));
      for (const id of requested) {
        const document = byId.get(id);
        if (document) yield {id, status: "document", document};
        else {
          const error = missingError(id);
          logSafeError("Shadow document batch failed", error);
          yield {id, status: "missing", listed: true, error};
        }
      }
    };
    let remaining = limit;
    while (remaining > 0) {
      const rows = await fetchShadowDocumentSizes({client: this.shadowClient, documentTypes, ids: requestedIds, filters,
        afterId, limit: Math.min(500, remaining)});
      if (!rows.length) break;
      let batch = [];
      let bytes = 1;
      for (const row of rows) {
        seen.add(row._id);
        if (batch.length && bytes + row.bytes + 1 > BATCH_PLANNING_BYTES) {
          yield* readBatch(batch, this);
          batch = [];
          bytes = 1;
        }
        batch.push(row);
        bytes += row.bytes + 1;
      }
      if (batch.length) yield* readBatch(batch, this);
      remaining -= rows.length;
      afterId = rows.at(-1)._id;
    }
    for (const id of requestedIds || []) {
      if (seen.has(id)) continue;
      const error = missingError(id);
      logSafeError("Shadow document batch failed", error);
      yield {id, status: "missing", error};
    }
  }

  referralSyncCursor(afterId) {
    return referralSyncCursor({client: this.shadowClient, afterId});
  }

  async fetchUpgradeLinkDataset(slug, selector, params) {
    const links = await this.dataset({
      documentTypes: ["upgradeLink"],
      filters: [{ path: "slug.current", op: "ieq", value: slug }],
      limit: 1,
    });
    // Legacy RPC fallback may return an unfiltered dataset. Preserve the GROQ
    // selector before choosing which reference to load.
    const selection = await evaluate(selector, { dataset: links, params });
    const link = await selection.get();
    if (!link) return [];
    const targetId = link.targetPackage?._ref;
    if (!targetId || targetId === link._id) return [link];
    const targets = await this.dataset({
      documentTypes: ["upgradeLink", "package"],
      ids: [targetId],
      limit: 1,
    });
    return [link, ...targets];
  }

  async fetchBookingSettingsDataset(id, selector, params) {
    const settings = await this.dataset({
      documentTypes: ["bookingSettings"],
      ids: [id],
      limit: 1,
    });
    const selection = await evaluate(selector, { dataset: settings, params });
    const selected = await selection.get();
    if (!selected) return [];
    const targetIds = uniqueStrings(
      (Array.isArray(selected.packageDateSlots) ? selected.packageDateSlots : [])
        .map((entry) => entry?.package?._ref)
        .filter((value) => typeof value === "string")
    );
    if (!targetIds.length) return [selected];
    const targets = await this.dataset({documentTypes: ["package"], ids: targetIds, requireAll: true});
    return [selected, ...targets];
  }

  async fetchRecoveryDataset(scope, params) {
    const documents = [];
    const excludedIds = [];
    const unavailable = [];
    while (documents.length < 50) {
      const ids = await fetchRecoveryPaymentIds({
        client: this.shadowClient,
        backend: params.backend,
        statuses: params.statuses,
        refundedStatus: params.refundedStatus,
        bookedStatus: params.bookedStatus,
        abandonedStatus: params.abandonedStatus,
        dodoEnabled: params.dodoEnabled,
        now: params.now,
        limit: 50 - documents.length,
        excludedIds,
      });
      if (!ids.length) break;
      excludedIds.push(...ids);
      for await (const outcome of this.documentBatches({documentTypes: scope.documentTypes, ids})) {
        if (outcome.status === "document") documents.push(outcome.document);
        else {
          logSafeError("Recovery payment document unavailable", outcome.error);
          unavailable.push({id: outcome.id, code: outcome.error.code, ...(outcome.bytes && {bytes: outcome.bytes})});
        }
      }
    }
    return {documents, unavailable};
  }

  async fetch(query, params = {}) {
    const tree = parse(String(query || ""));
    const scope = inferShadowScope({
      query,
      params,
      configuredTypes: this.documentTypes,
    });
    const recoveryQuery =
      this.commerceOnly &&
      String(query || "").includes("refundRequiresBookingSync") &&
      String(query || "").includes("nextRecoveryAt") &&
      Array.isArray(params?.statuses);
    // Both upgrade routes use this root selector. Fetch its referenced package
    // independently so unrelated links cannot consume the bounded dataset.
    const upgradeLinkQuery = String(query || "").match(
      /^\s*\*\[\s*_type\s*==\s*["']upgradeLink["']\s*&&\s*lower\(slug\.current\)\s*==\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*\]\s*\[\s*0\s*\]\s*\{/
    );
    const bookingSettingsQuery = String(query || "").match(
      /^\s*\*\[\s*_id\s*==\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*&&\s*_type\s*==\s*["']bookingSettings["']\s*\]\s*\[\s*0\s*\]\s*\{/
    );
    const recovery = recoveryQuery ? await this.fetchRecoveryDataset(scope, params) : null;
    const dataset = bookingSettingsQuery
      ? await this.fetchBookingSettingsDataset(params[bookingSettingsQuery[1]], tree.base, params)
      : upgradeLinkQuery
      ? await this.fetchUpgradeLinkDataset(params[upgradeLinkQuery[1]], tree.base, params)
      : recoveryQuery
      ? recovery.documents
      : await this.dataset(scope);
    const value = await evaluate(tree, {
      dataset,
      params: params || {},
    });
    const result = await value.get();
    if (recovery && Array.isArray(result)) result.unavailable = recovery.unavailable;
    return result;
  }

  async getDocument(id) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) return null;
    const documents = await this.dataset({ ids: [normalizedId], limit: 1 });
    return documents?.[0] || null;
  }

  fetchAvailability() {
    if (!this.commerceOnly) {
      throw new Error("Typed availability is only available to commerce clients.");
    }
    return fetchCommerceAvailability({ client: this.shadowClient });
  }

  referralEarnings({ referralId, referralCode } = {}) {
    return fetchReferralEarningsSummary({
      client: this.shadowClient,
      referralId,
      referralCode,
    });
  }

  upgradeBookingChain({ rootId } = {}) {
    return fetchUpgradeBookingChain({ client: this.shadowClient, rootId });
  }

  derivedCount({ kind, value } = {}) {
    return fetchCommerceDerivedCount({ client: this.shadowClient, kind, value });
  }

  config() {
    return { projectId: "supabase", dataset: "commerce" };
  }

  patch(id) {
    return new PatchBuilder(this, id);
  }

  transaction() {
    return new TransactionBuilder(this);
  }

  async create(document, options = {}) {
    const [created] = await applyShadowMutations({
      client: this.shadowClient,
      commerceMode: this.commerceOnly,
      cutoverGeneration: this.cutoverGeneration,
      commandId: options?.commandId,
      mutations: [{ operation: "create", document }],
    });
    return created;
  }

  async createIfNotExists(document, options = {}) {
    const [created] = await applyShadowMutations({
      client: this.shadowClient,
      commerceMode: this.commerceOnly,
      cutoverGeneration: this.cutoverGeneration,
      commandId: options?.commandId,
      mutations: [{ operation: "create_if_missing", document }],
    });
    return created;
  }

  async createOrReplace(document, options = {}) {
    const existing = await this.fetch(`*[_id == $id][0]`, { id: document?._id });
    const [created] = await applyShadowMutations({
      client: this.shadowClient,
      commerceMode: this.commerceOnly,
      cutoverGeneration: this.cutoverGeneration,
      commandId: options?.commandId,
      mutations: [
        existing
          ? {
              operation: "replace",
              document: resumeBookingConfirmation(existing, document),
              expected_revision: existing._rev || "",
            }
          : { operation: "create", document },
      ],
    });
    return created;
  }

  async delete(target, options = {}) {
    const expectedRevision = deleteRevision(options);
    if (typeof target === "string") {
      const existing = await this.fetch(`*[_id == $id][0]`, { id: target });
      if (!existing) return null;
      const [deleted] = await applyShadowMutations({
        client: this.shadowClient,
        commerceMode: this.commerceOnly,
        cutoverGeneration: this.cutoverGeneration,
        commandId: options?.commandId,
        mutations: [
          {
            operation: "delete",
            id: target,
            expected_revision: mutationRevision(expectedRevision, existing._rev),
          },
        ],
      });
      return deleted;
    }

    const matches = await this.fetch(target?.query || "", target?.params || {});
    const documents = Array.isArray(matches) ? matches : matches ? [matches] : [];
    const ids = documents
      .map((item) => (typeof item === "string" ? item : item?._id))
      .filter(Boolean);
    if (ids.length < 1) return null;
    return applyShadowMutations({
      client: this.shadowClient,
      commerceMode: this.commerceOnly,
      cutoverGeneration: this.cutoverGeneration,
      commandId: options?.commandId,
      mutations: ids.map((id) => ({
        operation: "delete", id,
        ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
      })),
    });
  }

  async commitPatch(patch, options = {}) {
    mutationRevision(patch.expectedRevision, "");
    const current = await this.fetch(`*[_id == $id][0]`, { id: patch.id });
    if (!current) {
      const error = new Error("Document not found.");
      error.statusCode = 404;
      throw error;
    }
    const [updated] = await applyShadowMutations({
      client: this.shadowClient,
      commerceMode: this.commerceOnly,
      cutoverGeneration: this.cutoverGeneration,
      commandId: options?.commandId,
      mutations: [
        {
          operation: "replace",
          document: applyPatch(current, patch),
          expected_revision: mutationRevision(patch.expectedRevision, current._rev),
        },
      ],
    });
    return updated;
  }

  async commitTransaction(operations, options = {}) {
    const operationIds = operations
      .map((operation) => operation.patch?.id || operation.id || operation.document?._id)
      .filter(Boolean);
    const dataset = await this.dataset({ ids: uniqueStrings(operationIds), limit: 1000 });
    const originals = new Map(dataset.map((document) => [document._id, document]));
    const documents = new Map(originals);
    const mutations = [];
    const pending = new Map();

    for (const operation of operations) {
      const id = operation.patch?.id || operation.id || operation.document?._id;
      const original = originals.get(id);
      const current = documents.get(id);
      const expected = mutationRevision(operation.patch?.expectedRevision ??
        operation.expectedRevision, original?._rev);
      if ((operation.patch?.expectedRevision !== undefined ||
          operation.expectedRevision !== undefined) && expected !== original?._rev) {
        throw revisionConflict();
      }
      const prior = pending.get(id);
      if (operation.type === "patch") {
        if (!current) throw new Error("Document not found.");
        const next = applyPatch(current, operation.patch);
        documents.set(id, next);
        if (prior && prior.operation !== "delete") {
          prior.document = next;
          if (prior.operation === "create_if_missing") {
            prior.operation = original ? "replace" : "create";
            if (original) prior.expected_revision = expected;
          }
        } else {
          const mutation = { operation: "replace", document: next, expected_revision: expected };
          mutations.push(mutation);
          pending.set(id, mutation);
        }
        continue;
      }
      if (operation.type === "delete") {
        if (!current) throw new Error("Document not found.");
        if (!original && prior?.operation === "create_if_missing") {
          prior.operation = "create";
        }
        if (prior?.operation === "replace") {
          mutations.splice(mutations.indexOf(prior), 1);
        }
        const mutation = { operation: "delete", id,
          expected_revision: !original && prior && ["create", "create_if_missing"].includes(prior.operation)
            ? "" : expected };
        mutations.push(mutation);
        pending.set(id, mutation);
        documents.delete(id);
        continue;
      }
      if (operation.type === "create" && current) {
        const error = new Error("Document already exists.");
        error.code = "23505";
        error.status = 409;
        error.statusCode = 409;
        throw error;
      }
      if (operation.type === "createIfNotExists" && current) {
        if (!prior) {
          const mutation = { operation: "create_if_missing", document: operation.document };
          mutations.push(mutation);
          pending.set(id, mutation);
        }
        continue;
      }
      const document = resumeBookingConfirmation(current, clone(operation.document));
      if (prior && prior.operation !== "delete") {
        prior.document = document;
        if (prior.operation === "create_if_missing") {
          prior.operation = original ? "replace" : "create";
          if (original) prior.expected_revision = expected;
        }
      } else {
        const mutation = { operation: operation.type === "createIfNotExists"
          ? "create_if_missing" : current ? "replace" : "create", document };
        if (mutation.operation === "replace") mutation.expected_revision = expected;
        mutations.push(mutation);
        pending.set(id, mutation);
      }
      documents.set(id, document);
    }

    const results = await applyShadowMutations({
      client: this.shadowClient,
      commerceMode: this.commerceOnly,
      cutoverGeneration: this.cutoverGeneration,
      commandId: options?.commandId,
      mutations,
    });
    return {
      results,
      documentIds: mutations.map((mutation) =>
        String(mutation.id || mutation.document?._id || "")
      ),
    };
  }
}

export const createSupabaseDocumentClient = (options = {}) =>
  new SupabaseDocumentClient(options);
