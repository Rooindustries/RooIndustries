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

export const getPublicContentEntry = async (resource, params, options) => {
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
        ...(options?.cache ? { cache: options.cache } : {}),
      });
      body = await response.json();
    } catch (error) {
      if (markCancelled(error, response).requestCancelled || !response) throw error;
    }
    if (!response.ok || body?.ok !== true || !Object.hasOwn(body, "data")) {
      throw new Error(body?.error || "Public content could not be loaded.");
    }
    const revision = Number.isSafeInteger(body.revision) && body.revision >= 0 ? body.revision : null;
    return { data: body.data, revision };
  } finally {
    pendingRequests -= 1;
  }
};

export const getPublicContent = async (resource, params, options) =>
  (await getPublicContentEntry(resource, params, options)).data;
