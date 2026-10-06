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

export const createAdminApi = () => {
  const request = async (path, { method = "GET", body, signal } = {}) => {
    let response;
    try {
      response = await fetch(path, {
        method,
        signal,
        cache: "no-store",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new AdminApiError(NETWORK_ERROR, { code: "NETWORK_ERROR" });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false || !payload) {
      throw new AdminApiError(payload?.error || `Request failed (${response.status}).`, {
        status: response.status,
        code: payload?.code || "",
        details: payload?.details ?? null,
      });
    }
    return payload.data;
  };

  return {
    getSession: () => request("/api/admin/content/session"),
    signIn: (body) => request("/api/admin/content/session", { method: "POST", body }),
    signOut: () => request("/api/admin/content/session", { method: "DELETE" }),
    listDocuments: (type, options) =>
      request(`/api/admin/content/documents?type=${encodeURIComponent(type)}`, options),
    getDocument: (id, options) =>
      request(`/api/admin/content/documents/${encodeURIComponent(id)}`, options),
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
