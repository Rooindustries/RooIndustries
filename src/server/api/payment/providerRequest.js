import DodoPayments from "dodopayments";
import { logSafeError } from "../../safeErrorLog.js";

export const providerDeadline = () => AbortSignal.timeout(8000);

export const requestProvider = async (url, options = {}) => {
  const signal = options.signal || providerDeadline();
  let reader;
  const cancel = () => {
    reader?.cancel(signal.reason).catch(error => logSafeError("Payment provider body cancellation failed", error));
  };
  try {
    signal.throwIfAborted();
    const response = await fetch(url, { ...options, signal });
    reader = response.body?.getReader();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const chunks = [];
    signal.throwIfAborted();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        chunks.push(value);
      }
    }
    return new Response(reader ? new Blob(chunks) : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    logSafeError("Payment provider request failed", signal.aborted ? signal.reason : error);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader?.releaseLock();
  }
};

export const createDodoTransport = (options, signal = providerDeadline()) => {
  return new DodoPayments({
    ...options,
    maxRetries: 0,
    timeout: 8000,
    fetch: (url, init) => requestProvider(url, {
      ...init, signal: AbortSignal.any([signal, init.signal]),
    }),
  });
};
