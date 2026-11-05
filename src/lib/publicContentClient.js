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

let pageHides = 0;
let currentHide = 0;
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    currentHide = ++pageHides;
  });
  window.addEventListener("pageshow", () => {
    currentHide = 0;
  });
}

const fetchFailureMessages = [
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
];

export const getPublicContent = async (resource, params, options) => {
  const signal = options?.signal;
  pendingRequests += 1;
  const hidesAtStart = pageHides;
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
      if (
        (signal?.aborted ? signal.reason?.name !== "TimeoutError" : currentHide > hidesAtStart) &&
        response?.ok !== false &&
        (error?.name === "AbortError" || (error instanceof TypeError && fetchFailureMessages.includes(error.message)))
      ) {
        error.requestCancelled = true;
        throw error;
      }
      if (!response) throw error;
    }
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.error || "Public content could not be loaded.");
    }
    return body.data ?? null;
  } finally {
    pendingRequests -= 1;
  }
};

export const reportContentLoadError = (error) => {
  if (!error?.requestCancelled) console.error(error);
};
