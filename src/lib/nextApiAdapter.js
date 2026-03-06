import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
let legacyServerEnvInitialized = false;

const parseDotenvFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }

    const parsed = {};
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      parsed[key] = value;
    }

    return parsed;
  } catch {
    return {};
  }
};

const firstDefined = (...values) => {
  for (const value of values) {
    if (value && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
};

const setEnvFallback = (key, value) => {
  if (!process.env[key] && value) {
    process.env[key] = value;
  }
};

const ensureLegacyServerEnv = () => {
  if (legacyServerEnvInitialized) {
    return;
  }
  legacyServerEnvInitialized = true;

  const envLocal = parseDotenvFile(path.join(process.cwd(), ".env.local"));
  const envFile = parseDotenvFile(path.join(process.cwd(), ".env"));

  setEnvFallback(
    "SANITY_PROJECT_ID",
    firstDefined(
      process.env.NEXT_PUBLIC_SANITY_PROJECT_ID,
      envLocal.SANITY_PROJECT_ID,
      envLocal.NEXT_PUBLIC_SANITY_PROJECT_ID,
      envFile.SANITY_PROJECT_ID,
      envFile.NEXT_PUBLIC_SANITY_PROJECT_ID
    )
  );

  setEnvFallback(
    "SANITY_DATASET",
    firstDefined(
      process.env.NEXT_PUBLIC_SANITY_DATASET,
      envLocal.SANITY_DATASET,
      envLocal.NEXT_PUBLIC_SANITY_DATASET,
      envFile.SANITY_DATASET,
      envFile.NEXT_PUBLIC_SANITY_DATASET
    )
  );

  setEnvFallback(
    "SANITY_API_VERSION",
    firstDefined(
      process.env.NEXT_PUBLIC_SANITY_API_VERSION,
      envLocal.SANITY_API_VERSION,
      envLocal.NEXT_PUBLIC_SANITY_API_VERSION,
      envFile.SANITY_API_VERSION,
      envFile.NEXT_PUBLIC_SANITY_API_VERSION
    )
  );

  setEnvFallback(
    "SANITY_WRITE_TOKEN",
    firstDefined(
      process.env.REACT_APP_SANITY_WRITE_TOKEN,
      process.env.SANITY_API_TOKEN,
      envLocal.SANITY_WRITE_TOKEN,
      envLocal.REACT_APP_SANITY_WRITE_TOKEN,
      envLocal.SANITY_API_TOKEN,
      envFile.SANITY_WRITE_TOKEN,
      envFile.REACT_APP_SANITY_WRITE_TOKEN,
      envFile.SANITY_API_TOKEN
    )
  );
};

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
    return {};
  }

  const contentType = String(request.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/json")) {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const formData = await request.formData();
      const body = {};

      for (const [key, value] of formData.entries()) {
        const normalized =
          typeof value === "string" ? value : value?.name || "";

        if (!(key in body)) {
          body[key] = normalized;
          continue;
        }

        if (Array.isArray(body[key])) {
          body[key].push(normalized);
          continue;
        }

        body[key] = [body[key], normalized];
      }

      return body;
    } catch {
      return {};
    }
  }

  try {
    const text = await request.text();
    return text ? { rawBody: text } : {};
  } catch {
    return {};
  }
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

export const loadLegacyApiHandler = async (filePath) => {
  ensureLegacyServerEnv();
  const loaded = await import(/* webpackIgnore: true */ pathToFileURL(filePath).href);
  return loaded?.default || loaded;
};

export const runLegacyApiHandler = async ({
  request,
  handler,
  query = {},
  methodOverride = "",
}) => {
  const url = new URL(request.url);
  const req = {
    method: String(methodOverride || request.method || "GET").toUpperCase(),
    url: request.url,
    query: {
      ...buildQueryObject(url.searchParams),
      ...query,
    },
    body: await readRequestBody(request),
    headers: buildHeadersObject(request.headers),
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
