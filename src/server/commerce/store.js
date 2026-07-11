const normalizeBackend = (value) =>
  String(value || "").trim().toLowerCase() === "supabase"
    ? "supabase"
    : "sanity";

export class CommerceStore {
  constructor({ client, backend = "sanity", cutoverGeneration = 0 } = {}) {
    if (!client) throw new Error("A commerce document backend is required.");
    this.client = client;
    this.backend = normalizeBackend(client.backend || backend);
    this.cutoverGeneration = Math.max(
      0,
      Number(client.cutoverGeneration ?? cutoverGeneration) || 0
    );
    this.commerceOnly = true;
  }

  fetch(query, params) {
    return this.client.fetch(query, params);
  }

  create(document, ...args) {
    return this.client.create(document, ...args);
  }

  createIfNotExists(document, ...args) {
    return this.client.createIfNotExists(document, ...args);
  }

  createOrReplace(document, ...args) {
    return this.client.createOrReplace(document, ...args);
  }

  patch(id) {
    return this.client.patch(id);
  }

  transaction() {
    return this.client.transaction();
  }

  delete(target, ...args) {
    return this.client.delete(target, ...args);
  }

  config() {
    return typeof this.client.config === "function"
      ? this.client.config()
      : { projectId: this.backend, dataset: "commerce" };
  }

  flushCommerceMirror(options) {
    return typeof this.client.flushCommerceMirror === "function"
      ? this.client.flushCommerceMirror(options)
      : Promise.resolve({ supported: false, attempted: 0, mirrored: 0, failed: 0 });
  }

  reconcileReverseMirror(options) {
    return typeof this.client.reconcileReverseMirror === "function"
      ? this.client.reconcileReverseMirror(options)
      : Promise.resolve({ supported: false });
  }

  get shadowClient() {
    return this.client.shadowClient || null;
  }
}

export const createCommerceStore = (options = {}) => new CommerceStore(options);
