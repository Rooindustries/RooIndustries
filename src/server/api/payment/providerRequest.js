export const requestProvider = async (url, options = {}) => {
  const signal = AbortSignal.timeout(8000);
  const response = await fetch(url, { ...options, signal });
  const reader = response.body?.getReader();
  const cancel = () => { reader?.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();

  return {
    ok: response.ok,
    status: response.status,
    async json() {
      const decoder = new TextDecoder();
      const chunks = [];
      try {
        signal.throwIfAborted();
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            chunks.push(decoder.decode(value, { stream: true }));
          }
        }
        chunks.push(decoder.decode());
        return JSON.parse(chunks.join(""));
      } finally {
        signal.removeEventListener("abort", cancel);
        reader?.releaseLock();
      }
    },
  };
};
