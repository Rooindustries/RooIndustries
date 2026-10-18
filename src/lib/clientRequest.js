export const CLIENT_REQUEST_TIMEOUT_MS = 8000;

export const requestDeadline = (timeoutMs = CLIENT_REQUEST_TIMEOUT_MS) => {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(
    () => controller.abort(new DOMException("Request timed out.", "TimeoutError")),
    timeoutMs
  );
  return controller.signal;
};

export const fetchJsonWithTimeout = async (
  url,
  options = {},
  fetchImpl = fetch,
  timeoutMs = CLIENT_REQUEST_TIMEOUT_MS
) => {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Request timed out.", "TimeoutError")),
    timeoutMs
  );
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const data = await response.json();
    return { response, data };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
};
