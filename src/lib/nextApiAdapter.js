import { isSameOriginMutation } from "../server/request/sameOrigin.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_REQUEST_BODY_BYTES = 128 * 1024;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 2000;

class RequestInputError extends Error {
  constructor(message, status = 400, code = "invalid_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const setHeaderValue = (store, name, value) => {
  const key = String(name || "").toLowerCase();
  if (!key) return;

  if (Array.isArray(value)) {
    store.set(key, value.map((entry) => String(entry)));
    return;
  }

  store.set(key, [String(value)]);
};

const getHeaderValue = (store, name) => {
  const key = String(name || "").toLowerCase();
  const values = store.get(key);
  if (!values) return undefined;
  if (key === "set-cookie") return [...values];
  return values.length === 1 ? values[0] : [...values];
};

const buildQueryObject = (searchParams) => {
  const query = {};

  for (const [key, value] of searchParams.entries()) {
    if (!(key in query)) {
      query[key] = value;
      continue;
    }

    if (Array.isArray(query[key])) {
      query[key].push(value);
      continue;
    }

    query[key] = [query[key], value];
  }

  return query;
};

const hasDuplicateQueryKeys = (searchParams) => {
  const seen = new Set();
  for (const key of searchParams.keys()) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
};

const hasDuplicateJsonKeys = (rawBody) => {
  const stack = [];
  for (let index = 0; index < rawBody.length; index += 1) {
    const char = rawBody[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < rawBody.length) {
        if (rawBody[index] === "\\") {
          index += 2;
          continue;
        }
        if (rawBody[index] === '"') break;
        index += 1;
      }
      let next = index + 1;
      while (/\s/.test(rawBody[next] || "")) next += 1;
      if (rawBody[next] === ":" && stack.at(-1)?.type === "object") {
        const key = JSON.parse(rawBody.slice(start, index + 1));
        if (stack.at(-1).keys.has(key)) return true;
        stack.at(-1).keys.add(key);
      }
      continue;
    }
    if (char === "{") stack.push({ type: "object", keys: new Set() });
    if (char === "[") stack.push({ type: "array" });
    if (char === "}" || char === "]") stack.pop();
  }
  return false;
};

const validateJsonShape = (root) => {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new RequestInputError("JSON body must be an object.");
  }
  const pending = [{ value: root, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop();
    nodes += 1;
    if (depth > MAX_JSON_DEPTH || nodes > MAX_JSON_NODES) {
      throw new RequestInputError("JSON body is too complex.", 413, "payload_too_complex");
    }
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value) && value.length > 500) {
      throw new RequestInputError("JSON array is too large.", 413, "payload_too_complex");
    }
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new RequestInputError("JSON body contains an unsafe property.");
      }
      if (child && typeof child === "object") {
        pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
};

const buildHeadersObject = (headers) => {
  const output = {};
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value;
  });
  return output;
};

const readRequestBody = async (request) => {
  const method = String(request.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return {
      body: {},
      rawBody: "",
    };
  }

  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestInputError("Request body is too large.", 413, "payload_too_large");
  }

  if (contentType.includes("application/json")) {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw new RequestInputError("Request body is too large.", 413, "payload_too_large");
    }
    if (!rawBody) return { body: {}, rawBody: "" };
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new RequestInputError("Malformed JSON body.", 400, "malformed_json");
    }
    if (hasDuplicateJsonKeys(rawBody)) {
      throw new RequestInputError("Duplicate JSON properties are not allowed.");
    }
    validateJsonShape(body);
    return { body, rawBody };
  }

  const text = await request.text();
  if (!text) return { body: {}, rawBody: "" };
  throw new RequestInputError(
    "Content-Type must be application/json.",
    415,
    "unsupported_media_type"
  );
};

const buildResponseHeaders = (headerStore) => {
  const headers = new Headers();

  for (const [key, values] of headerStore.entries()) {
    if (key === "set-cookie") {
      values.forEach((value) => headers.append(key, value));
      continue;
    }

    headers.set(key, values.join(", "));
  }

  return headers;
};

const createMutableResponse = () => {
  const headerStore = new Map();
  let statusCode = 200;
  let response = null;

  const finalize = (body, { status = statusCode, contentType = null } = {}) => {
    const headers = buildResponseHeaders(headerStore);
    if (!headers.has("cache-control")) {
      headers.set("cache-control", "no-store, max-age=0");
    }
    if (!headers.has("x-content-type-options")) {
      headers.set("x-content-type-options", "nosniff");
    }
    if (contentType && !headers.has("content-type")) {
      headers.set("content-type", contentType);
    }

    response = new Response(body, { status, headers });
    return response;
  };

  const apiRes = {
    status(code) {
      statusCode = Number(code) || 200;
      return apiRes;
    },
    setHeader(name, value) {
      setHeaderValue(headerStore, name, value);
      return apiRes;
    },
    getHeader(name) {
      return getHeaderValue(headerStore, name);
    },
    json(payload) {
      return finalize(JSON.stringify(payload), {
        status: statusCode,
        contentType: JSON_CONTENT_TYPE,
      });
    },
    send(payload) {
      if (payload === undefined || payload === null) {
        return finalize(null, { status: statusCode });
      }

      if (
        typeof payload === "object" &&
        !(payload instanceof Uint8Array) &&
        !(payload instanceof ArrayBuffer)
      ) {
        return finalize(JSON.stringify(payload), {
          status: statusCode,
          contentType: JSON_CONTENT_TYPE,
        });
      }

      return finalize(payload, { status: statusCode });
    },
    end(payload) {
      return finalize(payload ?? null, { status: statusCode });
    },
    redirect(location, code = 302) {
      statusCode = Number(code) || 302;
      setHeaderValue(headerStore, "Location", location);
      return finalize(null, { status: statusCode });
    },
  };

  Object.defineProperty(apiRes, "statusCode", {
    get() {
      return statusCode;
    },
    set(value) {
      statusCode = Number(value) || statusCode;
    },
  });

  return {
    apiRes,
    hasResponse: () => response instanceof Response,
    getResponse: () => response,
    finalizeDefault: () => finalize(null, { status: statusCode }),
  };
};

export const runLegacyApiHandler = async ({
  request,
  handler,
  query = {},
  methodOverride = "",
}) => {
  const url = new URL(request.url);
  const method = String(methodOverride || request.method || "GET").toUpperCase();
  if (!isSameOriginMutation(request)) {
    return Response.json(
      { ok: false, error: "Cross-origin request rejected.", code: "cross_origin_rejected" },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (hasDuplicateQueryKeys(url.searchParams)) {
    return Response.json(
      { ok: false, error: "Duplicate query parameters are not allowed.", code: "duplicate_query" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  let body;
  let rawBody;
  try {
    ({ body, rawBody } = await readRequestBody(request));
  } catch (error) {
    if (!(error instanceof RequestInputError)) throw error;
    return Response.json(
      { ok: false, error: error.message, code: error.code },
      { status: error.status, headers: { "Cache-Control": "no-store" } }
    );
  }
  const req = {
    method,
    url: request.url,
    query: {
      ...buildQueryObject(url.searchParams),
      ...query,
    },
    body,
    headers: buildHeadersObject(request.headers),
    rawBody,
  };

  const { apiRes, hasResponse, getResponse, finalizeDefault } =
    createMutableResponse();

  const result = await handler(req, apiRes);
  if (result instanceof Response) {
    return result;
  }

  if (hasResponse()) {
    return getResponse();
  }

  if (result !== undefined && result !== null) {
    if (
      typeof result === "object" &&
      !(result instanceof Uint8Array) &&
      !(result instanceof ArrayBuffer)
    ) {
      return Response.json(result);
    }

    return new Response(result);
  }

  return finalizeDefault();
};
