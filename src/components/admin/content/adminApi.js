export class AdminApiError extends Error {
  constructor(message, { status = 0, code = "", details = null } = {}) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const NETWORK_ERROR = "The admin service could not be reached. Check your connection and try again.";
const REQUEST_DEADLINE_MS = 25000;

export const createAdminApi = () => {
  const request = async (path, { method = "GET", body, signal } = {}) => {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_DEADLINE_MS);
    try {
      const response = await fetch(path, {
        method,
        signal: controller.signal,
        cache: "no-store",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let payload;
      try { payload = await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        payload = null;
      }
      if (controller.signal.aborted) throw Object.assign(new Error("Request aborted."), { name: "AbortError" });
      if (!response.ok || payload?.ok === false || !payload) {
        throw new AdminApiError(payload?.error || `Request failed (${response.status}).`, {
          status: response.status,
          code: payload?.code || "",
          details: payload?.details ?? null,
        });
      }
      return payload.data;
    } catch (error) {
      if (timedOut) throw new AdminApiError("The admin request timed out.", { code: "ADMIN_REQUEST_TIMEOUT" });
      if (error instanceof AdminApiError) throw error;
      if (error?.name === "AbortError") throw error;
      throw new AdminApiError(NETWORK_ERROR, { code: "NETWORK_ERROR" });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };

  return {
    getSession: () => request("/api/admin/content/session"),
    signIn: (body) => request("/api/admin/content/session", { method: "POST", body }),
    signOut: () => request("/api/admin/content/session", { method: "DELETE" }),
    listDocuments: (type, options) =>
      request(`/api/admin/content/documents?type=${encodeURIComponent(type)}`, options),
    getDocument: (id, options) =>
      request(`/api/admin/content/documents/${encodeURIComponent(id)}`, options),
    getCreateStatus: (type, createIntentId, document) =>
      request("/api/admin/content/publish/status", { method: "POST", body: { operation: "create", type, createIntentId, document } }),
    listRevisions: (id, options) =>
      request(`/api/admin/content/documents/${encodeURIComponent(id)}/revisions`, options),
    getRevision: (id, revisionId, options) =>
      request(
        `/api/admin/content/documents/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`,
        options
      ),
    publish: (body) => request("/api/admin/content/publish", { method: "POST", body }),
    startUpload: (body, { signal } = {}) =>
      request("/api/admin/content/assets/upload", { method: "POST", body, signal }),
    finalizeUpload: (uploadId, { signal } = {}) =>
      request("/api/admin/content/assets/finalize", { method: "POST", body: { uploadId }, signal }),
  };
};
