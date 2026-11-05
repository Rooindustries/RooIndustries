export const CLIENT_REQUEST_TIMEOUT_MS = 8000;

export const isRequestTimeout = (error) => error?.name === "TimeoutError" || error?.name === "AbortError";

export const requestTimeoutError = () => new DOMException("Request timed out.", "TimeoutError");

export const requestDeadline = (timeoutMs = CLIENT_REQUEST_TIMEOUT_MS) => {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(requestTimeoutError()), timeoutMs);
  return controller.signal;
};

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

export const watchPageLeave = (signal) => {
  const hidesAtStart = pageHides;
  return (error, response, requestSignal = signal) => {
    if (
      (requestSignal?.aborted ? requestSignal.reason?.name !== "TimeoutError" : currentHide > hidesAtStart) &&
      response?.ok !== false &&
      (error?.name === "AbortError" || (error instanceof TypeError && fetchFailureMessages.includes(error.message)))
    ) {
      error.requestCancelled = true;
    }
    return error;
  };
};

export const reportRequestError = (error) => {
  if (!error?.requestCancelled) console.error(error);
};

export const fetchJsonWithTimeout = async (url, options = {}, fetchImpl = fetch) => {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(requestTimeoutError()), CLIENT_REQUEST_TIMEOUT_MS);
  const markCancelled = watchPageLeave(controller.signal);
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: controller.signal });
    const data = await response.json();
    return { response, data };
  } catch (error) {
    throw markCancelled(error, response);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
};
