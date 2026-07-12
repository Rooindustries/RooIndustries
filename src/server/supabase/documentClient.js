import { evaluate, parse } from "groq-js";
import {
  applyShadowMutations,
  fetchCommerceAvailability,
  fetchRecoveryPaymentDocuments,
  fetchShadowDocuments,
} from "./shadowStore.js";

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

const inferShadowScope = ({ query, params = {}, configuredTypes = null }) => {
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
  return {
    documentTypes: documentTypes.length > 0 ? documentTypes : null,
    ids: uniqueStrings(ids),
    filters,
    limit: inferQueryLimit(source),
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

class PatchSpec {
  constructor(id) {
    this.id = String(id || "").trim();
    this.expectedRevision = "";
    this.operations = [];
  }

  ifRevisionId(revision) {
    this.expectedRevision = String(revision || "").trim();
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
  return next;
};

class PatchBuilder extends PatchSpec {
  constructor(client, id) {
    super(id);
    this.client = client;
  }

  commit(options = {}) {
    return this.client.commitPatch(this, options);
  }
}

class TransactionBuilder {
  constructor(client) {
    this.client = client;
    this.operations = [];
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
      expectedRevision: String(options?.ifRevisionId || "").trim(),
    });
    return this;
  }

  commit(options = {}) {
    return this.client.commitTransaction(this.operations, options);
  }
}

export class SupabaseDocumentClient {
  constructor({
    shadowClient,
    documentTypes = null,
    commerceOnly = false,
    cutoverGeneration = 0,
  } = {}) {
    this.shadowClient = shadowClient;
    this.backend = "supabase";
    this.commerceOnly = commerceOnly === true;
    this.cutoverGeneration = Math.max(0, Number(cutoverGeneration) || 0);
    this.documentTypes =
      Array.isArray(documentTypes) && documentTypes.length > 0
        ? [...new Set(documentTypes)]
        : null;
  }

  async dataset(scope = {}) {
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
    const documents = await fetchShadowDocuments({
      client: this.shadowClient,
      documentTypes: scope.documentTypes || this.documentTypes,
      ids: scope.ids,
      filters: scope.filters,
      limit: scope.limit,
      allowLegacyFallback: !this.commerceOnly,
    });
    if (
      this.commerceOnly &&
      Buffer.byteLength(JSON.stringify(documents), "utf8") >
        MAX_COMMERCE_PAYLOAD_BYTES
    ) {
      const error = new Error("Commerce query exceeded its database payload budget.");
      error.code = "COMMERCE_PAYLOAD_BUDGET_EXCEEDED";
      error.status = 503;
      error.statusCode = 503;
      throw error;
    }
    return documents;
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
    const dataset = recoveryQuery
      ? await fetchRecoveryPaymentDocuments({
          client: this.shadowClient,
          backend: params.backend,
          statuses: params.statuses,
          refundedStatus: params.refundedStatus,
          bookedStatus: params.bookedStatus,
          abandonedStatus: params.abandonedStatus,
          now: params.now,
          limit: 50,
        })
      : await this.dataset(scope);
    if (
      this.commerceOnly &&
      Buffer.byteLength(JSON.stringify(dataset), "utf8") >
        MAX_COMMERCE_PAYLOAD_BYTES
    ) {
      const error = new Error("Commerce query exceeded its database payload budget.");
      error.code = "COMMERCE_PAYLOAD_BUDGET_EXCEEDED";
      error.status = 503;
      error.statusCode = 503;
      throw error;
    }
    const value = await evaluate(tree, {
      dataset,
      params: params || {},
    });
    return value.get();
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
              document,
              expected_revision: existing._rev || "",
            }
          : { operation: "create", document },
      ],
    });
    return created;
  }

  async delete(target, options = {}) {
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
            expected_revision: existing._rev || "",
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
      mutations: ids.map((id) => ({ operation: "delete", id })),
    });
  }

  async commitPatch(patch, options = {}) {
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
          expected_revision: patch.expectedRevision || current._rev || "",
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
    const documents = new Map(dataset.map((document) => [document._id, document]));
    const mutations = [];

    for (const operation of operations) {
      if (operation.type === "patch") {
        const current = documents.get(operation.patch.id);
        if (!current) throw new Error("Document not found.");
        const next = applyPatch(current, operation.patch);
        documents.set(operation.patch.id, next);
        mutations.push({
          operation: "replace",
          document: next,
          expected_revision:
            operation.patch.expectedRevision || current._rev || "",
        });
        continue;
      }
      if (operation.type === "delete") {
        const current = documents.get(operation.id);
        mutations.push({
          operation: "delete",
          id: operation.id,
          expected_revision:
            operation.expectedRevision || current?._rev || "",
        });
        documents.delete(operation.id);
        continue;
      }

      const document = operation.document;
      const current = documents.get(document?._id);
      const mutationOperation =
        operation.type === "createIfNotExists"
          ? "create_if_missing"
          : operation.type === "createOrReplace" && current
            ? "replace"
            : "create";
      mutations.push({
        operation: mutationOperation,
        document,
        ...(mutationOperation === "replace"
          ? { expected_revision: current?._rev || "" }
          : {}),
      });
      documents.set(document?._id, document);
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
