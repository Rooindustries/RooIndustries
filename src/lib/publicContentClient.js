import { watchPageLeave } from "./clientRequest";

const buildPublicContentUrl = (resource, params = {}) => {
  const url = new URL(
    `/api/content/${encodeURIComponent(resource)}`,
    window.location.origin
  );
  Object.entries(params).forEach(([key, value]) => {
    const values = Array.isArray(value) ? value : [value];
    values
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .forEach((item) => url.searchParams.append(key, item));
  });
  return `${url.pathname}${url.search}`;
};

let pendingRequests = 0;
export const getPublicContentPendingCount = () => pendingRequests;

export const getPublicContent = async (resource, params, options) => {
  const signal = options?.signal;
  pendingRequests += 1;
  const markCancelled = watchPageLeave(signal);
  let response;
  let body;
  try {
    try {
      response = await fetch(buildPublicContentUrl(resource, params), {
        headers: { Accept: "application/json" },
        signal,
      });
      body = await response.json();
    } catch (error) {
      if (markCancelled(error, response).requestCancelled || !response) throw error;
    }
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.error || "Public content could not be loaded.");
    }
    return body.data ?? null;
  } finally {
    pendingRequests -= 1;
  }
};
