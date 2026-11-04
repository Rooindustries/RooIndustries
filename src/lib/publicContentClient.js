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

const readRevision = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

export const getPublicContentEntry = async (resource, params = {}, options = {}) => {
  pendingRequests += 1;
  try {
    const response = await fetch(buildPublicContentUrl(resource, params), {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.cache ? { cache: options.cache } : {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.error || "Public content could not be loaded.");
    }
    return { data: body.data ?? null, revision: readRevision(body.revision) };
  } finally {
    pendingRequests -= 1;
  }
};

export const getPublicContent = async (resource, params = {}, options = {}) =>
  (await getPublicContentEntry(resource, params, options)).data;
