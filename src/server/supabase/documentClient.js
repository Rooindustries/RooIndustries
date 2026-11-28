import crypto from "node:crypto";
import { evaluate, parse } from "groq-js";
import { isBookingBlockingStatus } from "../booking/bookingStatus.js";
import {
  applyShadowMutations,
  beginReconcileRecordInspection,
  clearReconcileCleanupBlock,
  completeReconcileCleanupRun,
  failReconcileCleanupRun,
  fetchCommerceAvailability,
  fetchCommerceDerivedCount,
  fetchCommerceDocumentIds,
  fetchOwnerReviewDodoDocuments,
  fetchReferralEarningsSummary,
  fetchRecoveryPaymentDocuments,
  fetchShadowDocuments,
  fetchUpgradeBookingChain,
  startReconcileCleanupRun,
} from "./shadowStore.js";
import { WRITE_CONFLICT_CODE } from "./writeConflict.js";

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

const payloadBudgetError = () => Object.assign(
  new Error("Commerce query exceeded its database payload budget."),
  { code: "COMMERCE_PAYLOAD_BUDGET_EXCEEDED", status: 503, statusCode: 503 }
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

const PUSHED_OPERATORS = { "==": "eq", in: "in", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };
const KEY_PATHS = ["_id", "_type"];

const andList = (node) => {
  if (node.type === "Group") return andList(node.base);
  return node.type === "And" ? [...andList(node.left), ...andList(node.right)] : [node];
};

const rootConjuncts = (tree) => {
  let conjuncts = [];
  let node = tree.type === "FuncCall" && tree.name === "count" ? tree.args[0] : tree;
  for (; node && node.type !== "Everything"; node = node.base) {
    if (node.type === "Filter") conjuncts = [...andList(node.expr), ...conjuncts];
    else if (conjuncts.length > 0) return null;
  }
  return node ? conjuncts : null;
};

const attributePath = (node) => {
  if (node.type !== "AccessAttribute") return null;
  if (!node.base) return node.name;
  const parent = attributePath(node.base);
  return parent && `${parent}.${node.name}`;
};

const readComparison = (conjunct) => {
  if (conjunct.type !== "OpCall") return {};
  const lowered = conjunct.left.type === "FuncCall" && conjunct.left.name === "lower";
  const path = attributePath(lowered ? conjunct.left.args[0] : conjunct.left);
  return { path, lowered, operator: conjunct.op, right: conjunct.right };
};

const pushedFilter = (conjunct, params) => {
  const { path, lowered, operator, right } = readComparison(conjunct);
  if (!path || KEY_PATHS.includes(path) || right.type !== "Parameter") return null;
  const op = lowered ? operator === "==" && "ieq" : PUSHED_OPERATORS[operator];
  const value = params[right.name];
  return op && value !== undefined ? { path, op, value } : null;
};

const matchesKey = (conjunct, params, pushesIds) => {
  const { path, lowered, operator, right } = readComparison(conjunct);
  if (lowered || !KEY_PATHS.includes(path)) return false;
  if (path === "_id") return pushesIds && ["==", "in"].includes(operator) && right.type === "Parameter";
  return operator === "==" && (right.type === "Value" || (right.type === "Parameter" && Boolean(params[right.name])));
};

export const inferShadowScope = ({
  query,
  params = {},
  configuredTypes = null,
  tree = parse(String(query || "")),
}) => {
  const source = String(query || "");
  const literalTypes = inferLiteralTypes(source);
  const paramType = source.match(/_type\s*==\s*\$([A-Za-z_][A-Za-z0-9_]*)/);
  const documentTypes = uniqueStrings([
    ...(literalTypes.length > 0 ? literalTypes : configuredTypes || []),
    ...(paramType && params[paramType[1]] ? [params[paramType[1]]] : []),
    ...(source.includes("->") ? ["package"] : []),
  ]);
  const pushesConditions = !source.includes("||") && !source.includes("->");
  const ids = [];
  if (pushesConditions) {
    const idEq = source.match(/_id\s*==\s*\$([A-Za-z_][A-Za-z0-9_]*)/);
    if (idEq && params[idEq[1]]) ids.push(params[idEq[1]]);
    const idIn = source.match(/_id\s+in\s+\$([A-Za-z_][A-Za-z0-9_]*)/);
    if (idIn && Array.isArray(params[idIn[1]])) ids.push(...params[idIn[1]]);
  }
  const pushedIds = uniqueStrings(ids);

  const conjuncts = rootConjuncts(tree);
  const filters = [];
  let fullyJudged = Boolean(conjuncts);
  for (const conjunct of conjuncts || []) {
    const filter = pushesConditions && pushedFilter(conjunct, params);
    if (filter) filters.push(filter);
    else if (!matchesKey(conjunct, params, pushesConditions)) fullyJudged = false;
  }
  const queryLimit = inferQueryLimit(source);
  const idsBoundRead = pushedIds.length > 0 && pushedIds.length <= queryLimit;
  const capped = (source.match(/\*\s*\[/g) || []).length > 1 || source.includes("->") || !(fullyJudged || idsBoundRead);
  const pinnedIds = [];
  for (const match of source.matchAll(/_id\s*==\s*(?:["']([^"']+)["']|\$([A-Za-z_][A-Za-z0-9_]*))/g)) {
    pinnedIds.push(match[1] || params[match[2]]);
  }
  return {
    documentTypes: documentTypes.length > 0 ? documentTypes : null,
    ids: pushedIds,
    filters,
    limit: capped ? 1000 : queryLimit,
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
  error.code = WRITE_CONFLICT_CODE;
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

const hasMatchingBaseDocument = (id, expectedRevision, baseDocument) =>
  Boolean(
    baseDocument &&
      typeof baseDocument === "object" &&
      !Array.isArray(baseDocument) &&
      baseDocument._id === id &&
      typeof baseDocument._type === "string" &&
      baseDocument._type.trim() &&
      typeof expectedRevision === "string" &&
      expectedRevision.trim() &&
      baseDocument._rev === expectedRevision
  );

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
  } = {}) {
    this.shadowClient = shadowClient;
    this.readDocuments = readDocuments;
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

  async listDocumentIds(documentType) {
    return fetchCommerceDocumentIds({ client: this.shadowClient, documentType });
  }

  async *documentBatches({ documentType, ids }) {
    let batchSize = 25;
    const readBatch = async function* (batch, client) {
      const documents = await client.readDocuments({
        client: client.shadowClient, documentTypes: [documentType], ids: batch,
        limit: batch.length, allowLegacyFallback: client.allowLegacyFallback,
      });
      const bytes = Buffer.byteLength(JSON.stringify(documents), "utf8");
      batchSize = Math.min(100, Math.max(1, Math.floor(0.8 * MAX_COMMERCE_PAYLOAD_BYTES * batch.length / bytes)));
      if (bytes > MAX_COMMERCE_PAYLOAD_BYTES) {
        if (batch.length > 1) {
          const middle = Math.ceil(batch.length / 2);
          yield* readBatch(batch.slice(0, middle), client);
          yield* readBatch(batch.slice(middle), client);
        } else {
          const id = batch[0];
          const error = Object.assign(payloadBudgetError(), { id, documentType, bytes });
          yield { id, status: "oversized", bytes, error };
        }
        return;
      }
      const byId = new Map(documents.map((document) => [document._id, document]));
      for (const id of batch) {
        const document = byId.get(id);
        if (document) yield { id, status: "document", document };
        else {
          const error = Object.assign(new Error("Shadow document is missing."), {
            code: "SHADOW_DOCUMENT_MISSING", status: 503, statusCode: 503, id, documentType,
          });
          yield { id, status: "missing", error };
        }
      }
    };
    for (let offset = 0; offset < ids.length;) {
      const batch = ids.slice(offset, offset + batchSize);
      yield* readBatch(batch, this);
      offset += batch.length;
    }
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
    let documents = await this.readDocuments({
      client: this.shadowClient,
      documentTypes: scope.documentTypes || this.documentTypes,
      ids: scope.ids,
      filters: scope.filters,
      limit: scope.limit,
      allowLegacyFallback: this.allowLegacyFallback,
    });
    if (scope.capped && documents.length >= scope.limit) {
      console.error("Shadow document read hit its cap; results may be incomplete. Owner attention is required.", { code: "SHADOW_READ_CAPPED", documentTypes: scope.documentTypes, limit: scope.limit });
    }
    if (scope.capped && scope.pinnedIds.length) {
      const pinned = await this.readDocuments({
        client: this.shadowClient,
        documentTypes: scope.documentTypes || this.documentTypes,
        ids: scope.pinnedIds,
        limit: scope.pinnedIds.length,
        allowLegacyFallback: this.allowLegacyFallback,
      });
      documents = [...new Map([...documents, ...pinned].map(document => [document._id, document])).values()];
    }
    if (
      this.commerceOnly &&
      Buffer.byteLength(JSON.stringify(documents), "utf8") >
        MAX_COMMERCE_PAYLOAD_BYTES
    ) {
      throw payloadBudgetError();
    }
    return documents;
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
    const targets = [];
    for (let index = 0; index < targetIds.length; index += 1000) {
      targets.push(...await this.dataset({
        documentTypes: ["package"],
        ids: targetIds.slice(index, index + 1000),
        limit: 1000,
      }));
    }
    return [selected, ...targets];
  }

  async fetch(query, params = {}) {
    const tree = parse(String(query || ""));
    const scope = inferShadowScope({
      query,
      params,
      configuredTypes: this.documentTypes,
      tree,
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
    const dataset = bookingSettingsQuery
      ? await this.fetchBookingSettingsDataset(params[bookingSettingsQuery[1]], tree.base, params)
      : upgradeLinkQuery
      ? await this.fetchUpgradeLinkDataset(params[upgradeLinkQuery[1]], tree.base, params)
      : recoveryQuery
      ? await fetchRecoveryPaymentDocuments({
          client: this.shadowClient,
          backend: params.backend,
          statuses: params.statuses,
          refundedStatus: params.refundedStatus,
          bookedStatus: params.bookedStatus,
          abandonedStatus: params.abandonedStatus,
          dodoEnabled: params.dodoEnabled,
          now: params.now,
          limit: 50,
          runId: params.runId || null,
        })
      : await this.dataset(scope);
    if (
      this.commerceOnly &&
      Buffer.byteLength(JSON.stringify(dataset), "utf8") >
        MAX_COMMERCE_PAYLOAD_BYTES
    ) {
      throw payloadBudgetError();
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

  async getDocumentsByIds(ids = [], { documentTypes = null } = {}) {
    const normalizedIds = uniqueStrings(ids);
    if (!normalizedIds.length) return [];
    return this.dataset({
      ...(Array.isArray(documentTypes) && documentTypes.length > 0
        ? { documentTypes }
        : {}),
      ids: normalizedIds,
      limit: Math.min(1000, normalizedIds.length),
    });
  }

  fetchAvailability() {
    if (!this.commerceOnly) {
      throw new Error("Typed availability is only available to commerce clients.");
    }
    return fetchCommerceAvailability({ client: this.shadowClient });
  }

  startReconcileCleanupRun(o = {}) { return startReconcileCleanupRun({ ...o, client: this.shadowClient }); }
  fetchOwnerReviewDodoDocuments(o = {}) { return fetchOwnerReviewDodoDocuments({ ...o, client: this.shadowClient }); }
  beginReconcileRecordInspection(o = {}) { return beginReconcileRecordInspection({ ...o, client: this.shadowClient }); }
  clearReconcileCleanupBlock(o = {}) { return clearReconcileCleanupBlock({ ...o, client: this.shadowClient }); }
  failReconcileCleanupRun(o = {}) { return failReconcileCleanupRun({ ...o, client: this.shadowClient }); }
  completeReconcileCleanupRun(o = {}) { return completeReconcileCleanupRun({ ...o, client: this.shadowClient }); }

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
    const current = hasMatchingBaseDocument(
      patch.id,
      patch.expectedRevision,
      options?.baseDocument
    )
      ? options.baseDocument
      : await this.fetch(`*[_id == $id][0]`, { id: patch.id });
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
    const known =
      options?.knownDocuments instanceof Map ? options.knownDocuments : null;
    const originals = new Map();
    const missingIds = [];
    for (const operation of operations) {
      const id = operation.patch?.id || operation.id || operation.document?._id;
      if (!id) continue;
      const hasKnown = Boolean(known && known.has(id));
      const knownDoc = hasKnown ? known.get(id) : undefined;
      const satisfied =
        hasKnown &&
        ((operation.type === "create" && knownDoc === null) ||
          (operation.type === "patch" &&
            hasMatchingBaseDocument(id, operation.patch?.expectedRevision, knownDoc)) ||
          (operation.type === "delete" &&
            hasMatchingBaseDocument(id, operation.expectedRevision, knownDoc)));
      if (satisfied) {
        if (knownDoc) originals.set(id, knownDoc);
      } else {
        missingIds.push(id);
      }
    }
    const idsToFetch = uniqueStrings(missingIds);
    if (idsToFetch.length > 0) {
      const dataset = await this.dataset({ ids: idsToFetch, limit: 1000 });
      for (const id of idsToFetch) originals.delete(id);
      for (const document of dataset) originals.set(document._id, document);
    }
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
