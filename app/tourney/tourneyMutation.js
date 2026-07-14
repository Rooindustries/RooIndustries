const createCommandId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
};

const MAX_PENDING_COMMAND_AGE_MS = 24 * 60 * 60 * 1000;
const MEMORY_PENDING_COMMANDS =
  globalThis.__rooPendingTourneyMutationCommands ||
  (globalThis.__rooPendingTourneyMutationCommands = new Map());

const hashMutationFingerprint = (value) => {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right
    .toString(16)
    .padStart(8, "0")}`;
};

const commandStorageKey = (url, options) => {
  const method = String(options.method || "GET").trim().toUpperCase();
  const body = typeof options.body === "string" ? options.body : "";
  return `roo:tourney:mutation:${hashMutationFingerprint(`${method}\n${url}\n${body}`)}`;
};

const readPendingCommand = (key) => {
  let record = MEMORY_PENDING_COMMANDS.get(key) || null;
  try {
    const stored = globalThis.sessionStorage?.getItem(key);
    if (stored) record = JSON.parse(stored);
  } catch {
    // In-memory persistence still protects retries in restricted browsers.
  }
  if (
    !record?.commandId ||
    !Number.isFinite(Number(record.createdAt)) ||
    Date.now() - Number(record.createdAt) > MAX_PENDING_COMMAND_AGE_MS
  ) {
    MEMORY_PENDING_COMMANDS.delete(key);
    try {
      globalThis.sessionStorage?.removeItem(key);
    } catch {
      // Ignore unavailable browser storage.
    }
    return null;
  }
  MEMORY_PENDING_COMMANDS.set(key, record);
  return record;
};

const persistPendingCommand = (key, commandId) => {
  const record = { commandId, createdAt: Date.now() };
  MEMORY_PENDING_COMMANDS.set(key, record);
  try {
    globalThis.sessionStorage?.setItem(key, JSON.stringify(record));
  } catch {
    // In-memory persistence still protects retries in restricted browsers.
  }
};

const clearPendingCommand = (key, commandId) => {
  if (MEMORY_PENDING_COMMANDS.get(key)?.commandId === commandId) {
    MEMORY_PENDING_COMMANDS.delete(key);
  }
  try {
    const stored = JSON.parse(globalThis.sessionStorage?.getItem(key) || "null");
    if (stored?.commandId === commandId) globalThis.sessionStorage.removeItem(key);
  } catch {
    // Ignore unavailable or invalid browser storage.
  }
};

const isDefinitiveMutationResponse = (response) =>
  response.ok ||
  (response.status >= 400 &&
    response.status < 500 &&
    ![408, 409, 425, 429].includes(response.status));

const withCommandCompletion = ({ response, storageKey, commandId }) =>
  new Proxy(response, {
    get(target, property) {
      if (property === "json") {
        return async () => {
          const body = await target.json();
          if (isDefinitiveMutationResponse(target)) {
            clearPendingCommand(storageKey, commandId);
          }
          return body;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

export const tourneyMutationFetch = async (url, options = {}) => {
  const { idempotencyKey: explicitCommandId, ...fetchOptions } = options;
  const storageKey = commandStorageKey(url, fetchOptions);
  const pending = readPendingCommand(storageKey);
  const idempotencyKey = explicitCommandId || pending?.commandId || createCommandId();
  if (!explicitCommandId && !pending) persistPendingCommand(storageKey, idempotencyKey);
  const request = () => fetch(url, {
    ...fetchOptions,
    headers: {
      ...(fetchOptions.headers || {}),
      "Idempotency-Key": idempotencyKey,
    },
  });
  let response;
  try {
    response = await request();
  } catch {
    response = await request();
  }
  return withCommandCompletion({ response, storageKey, commandId: idempotencyKey });
};

export const tourneyMutationSuccessMessage = (data, message) =>
  data?.syncPending
    ? `${message} Synchronization is completing in the background.`
    : message;
