const createCommandId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
};

export const tourneyMutationFetch = async (url, options = {}) => {
  const idempotencyKey = createCommandId();
  const request = () => fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "Idempotency-Key": idempotencyKey,
    },
  });
  try {
    return await request();
  } catch {
    return request();
  }
};

export const tourneyMutationSuccessMessage = (data, message) =>
  data?.syncPending
    ? `${message} Synchronization is completing in the background.`
    : message;
