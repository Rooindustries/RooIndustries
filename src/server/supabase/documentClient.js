import { evaluate, parse } from "groq-js";
import {
  applyShadowMutations,
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

  commit() {
    return this.client.commitPatch(this);
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

  delete(id) {
    this.operations.push({ type: "delete", id: String(id || "").trim() });
    return this;
  }

  commit() {
    return this.client.commitTransaction(this.operations);
  }
}

export class SupabaseDocumentClient {
  constructor({ shadowClient, documentTypes = null } = {}) {
    this.shadowClient = shadowClient;
    this.documentTypes =
      Array.isArray(documentTypes) && documentTypes.length > 0
        ? [...new Set(documentTypes)]
        : null;
  }

  async dataset() {
    return fetchShadowDocuments({
      client: this.shadowClient,
      documentTypes: this.documentTypes,
    });
  }

  async fetch(query, params = {}) {
    const tree = parse(String(query || ""));
    const value = await evaluate(tree, {
      dataset: await this.dataset(),
      params: params || {},
    });
    return value.get();
  }

  patch(id) {
    return new PatchBuilder(this, id);
  }

  transaction() {
    return new TransactionBuilder(this);
  }

  async create(document) {
    const [created] = await applyShadowMutations({
      client: this.shadowClient,
      mutations: [{ operation: "create", document }],
    });
    return created;
  }

  async createIfNotExists(document) {
    const [created] = await applyShadowMutations({
      client: this.shadowClient,
      mutations: [{ operation: "create_if_missing", document }],
    });
    return created;
  }

  async createOrReplace(document) {
    const existing = await this.fetch(`*[_id == $id][0]`, { id: document?._id });
    const [created] = await applyShadowMutations({
      client: this.shadowClient,
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

  async delete(target) {
    if (typeof target === "string") {
      const existing = await this.fetch(`*[_id == $id][0]`, { id: target });
      if (!existing) return null;
      const [deleted] = await applyShadowMutations({
        client: this.shadowClient,
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
      mutations: ids.map((id) => ({ operation: "delete", id })),
    });
  }

  async commitPatch(patch) {
    const current = await this.fetch(`*[_id == $id][0]`, { id: patch.id });
    if (!current) {
      const error = new Error("Document not found.");
      error.statusCode = 404;
      throw error;
    }
    const [updated] = await applyShadowMutations({
      client: this.shadowClient,
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

  async commitTransaction(operations) {
    const dataset = await this.dataset();
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
          expected_revision: current?._rev || "",
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
