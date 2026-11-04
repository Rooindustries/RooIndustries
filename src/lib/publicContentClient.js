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

const fetchFailureMessages = new Set([
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
]);

export const getPublicContent = async (resource, params = {}, options = {}) => {
  pendingRequests += 1;
  let pageLeft = false;
  const markPageLeft = () => {
    pageLeft = true;
  };
  window.addEventListener("pagehide", markPageLeft);
  const markCancelled = (error) => {
    const aborted = options.signal?.aborted || pageLeft;
    const abortError =
      error?.name === "AbortError" || (error instanceof TypeError && fetchFailureMessages.has(error.message));
    if (aborted && abortError) error.requestCancelled = true;
    return error;
  };
  try {
    const response = await fetch(buildPublicContentUrl(resource, params), {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      ...(options.signal ? { signal: options.signal } : {}),
    }).catch((error) => {
      throw markCancelled(error);
    });
    const body = await response.json().catch((error) => {
      if (response.ok && markCancelled(error).requestCancelled) throw error;
      return {};
    });
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.error || "Public content could not be loaded.");
    }
    return body.data ?? null;
  } finally {
    window.removeEventListener("pagehide", markPageLeft);
    pendingRequests -= 1;
  }
};
