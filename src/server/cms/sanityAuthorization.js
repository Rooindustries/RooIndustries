import {
  GLOBAL_SANITY_DATASET,
  GLOBAL_SANITY_PROJECT_ID,
  normalizeGlobalCmsDocument,
  publishedDocumentId,
  stableCmsJson,
} from "../../lib/globalCmsContract.js";

const DEFAULT_STUDIO_ORIGIN = "https://rooindustries.sanity.studio";
const SANITY_API_VERSION = "v2025-02-19";
const SANITY_USER_API_VERSION = "v2021-06-07";

const failure = (message, status, code) => {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  error.code = code;
  return error;
};

export const allowedCmsStudioOrigins = (env = process.env) => {
  const configured = String(env.CMS_STUDIO_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const origins = new Set([DEFAULT_STUDIO_ORIGIN, ...configured]);
  if (env.NODE_ENV !== "production") {
    origins.add("http://localhost:3333");
    origins.add("http://127.0.0.1:3333");
  }
  return origins;
};

export const assertCmsStudioOrigin = ({ origin, env = process.env } = {}) => {
  const normalized = String(origin || "").trim();
  if (!normalized || !allowedCmsStudioOrigins(env).has(normalized)) {
    throw failure(
      "The CMS request origin is not allowed.",
      403,
      "CMS_ORIGIN_DENIED",
    );
  }
  return normalized;
};

export const readSanityBearerToken = (authorization) => {
  const match = String(authorization || "").match(/^Bearer\s+([^\s]+)$/i);
  const token = String(match?.[1] || "");
  if (!token || token.length > 4096) {
    throw failure("CMS authentication is required.", 401, "CMS_AUTH_REQUIRED");
  }
  return token;
};

const requestSanity = async ({
  fetchImpl,
  url,
  token,
  method = "GET",
  body,
}) => {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw failure(
      "CMS authorization is temporarily unavailable.",
      503,
      "CMS_AUTH_UNAVAILABLE",
    );
  }
  if (!response.ok) {
    const status = [401, 403].includes(response.status) ? response.status : 503;
    throw failure(
      status === 401
        ? "CMS authentication is required."
        : status === 403
          ? "The Sanity user cannot perform this CMS action."
          : "CMS authorization is temporarily unavailable.",
      status,
      status === 401
        ? "CMS_AUTH_REQUIRED"
        : status === 403
          ? "CMS_PERMISSION_DENIED"
          : "CMS_AUTH_UNAVAILABLE",
    );
  }
  return response.json();
};

const verifySanityMutation = async ({
  fetchImpl,
  token,
  operation,
  documentId,
  document,
}) => {
  const mutation =
    operation === "publish"
      ? { createOrReplace: document }
      : { delete: { id: documentId } };
  const url = new URL(
    `https://${GLOBAL_SANITY_PROJECT_ID}.api.sanity.io/${SANITY_API_VERSION}/data/mutate/${GLOBAL_SANITY_DATASET}`,
  );
  url.searchParams.set("dryRun", "true");
  url.searchParams.set("returnIds", "true");
  await requestSanity({
    fetchImpl,
    url,
    token,
    method: "POST",
    body: { mutations: [mutation] },
  });
};

const loadCurrentSanityDocuments = async ({ fetchImpl, token, documentId }) => {
  const publishedId = publishedDocumentId(documentId);
  const url = new URL(
    `https://${GLOBAL_SANITY_PROJECT_ID}.api.sanity.io/${SANITY_API_VERSION}/data/query/${GLOBAL_SANITY_DATASET}`,
  );
  url.searchParams.set("query", "*[_id in $ids]");
  url.searchParams.set(
    "$ids",
    JSON.stringify([publishedId, `drafts.${publishedId}`]),
  );
  const response = await requestSanity({ fetchImpl, url, token });
  return Array.isArray(response?.result) ? response.result : [];
};

const verifySanitySource = async ({
  fetchImpl,
  token,
  operation,
  documentId,
  document,
  sourceRevision,
}) => {
  const revision = String(sourceRevision || "").trim();
  if (!revision || revision.length > 128) {
    throw failure(
      "The CMS source revision is invalid.",
      409,
      "CMS_SOURCE_STALE",
    );
  }
  const candidates = await loadCurrentSanityDocuments({
    fetchImpl,
    token,
    documentId,
  });
  const publishedId = publishedDocumentId(documentId);
  const published = candidates.find(
    (candidate) => candidate?._id === publishedId,
  );
  const current =
    operation === "publish"
      ? candidates.find((candidate) => candidate?._rev === revision)
      : published
        ? published._rev === revision
          ? published
          : null
        : candidates.find(
            (candidate) =>
              candidate?._id === `drafts.${publishedId}` &&
              candidate?._rev === revision,
          );
  if (!current) {
    throw failure(
      "The Sanity document changed before this command was authorized.",
      409,
      "CMS_SOURCE_STALE",
    );
  }
  if (operation !== "publish") return;
  const authoritative = normalizeGlobalCmsDocument({
    document: current,
    id: documentId,
    type: document?._type,
  });
  if (stableCmsJson(authoritative) !== stableCmsJson(document)) {
    throw failure(
      "The Sanity document content changed before this command was authorized.",
      409,
      "CMS_SOURCE_STALE",
    );
  }
};

export const identifyGlobalCmsUser = async ({
  authorization,
  fetchImpl = fetch,
} = {}) => {
  const token = readSanityBearerToken(authorization);
  const user = await requestSanity({
    fetchImpl,
    url: `https://${GLOBAL_SANITY_PROJECT_ID}.api.sanity.io/${SANITY_USER_API_VERSION}/users/me`,
    token,
  });
  const userId = String(user?.sanityUserId || user?.id || "").trim();
  if (!userId || userId.length > 120) {
    throw failure(
      "The Sanity user could not be verified.",
      403,
      "CMS_USER_INVALID",
    );
  }
  return { token, actor: `sanity:${userId}` };
};

export const verifyGlobalCmsMutation = async ({
  caller,
  operation,
  documentId,
  document,
  sourceRevision,
  fetchImpl = fetch,
} = {}) => {
  const token = String(caller?.token || "");
  if (!token) {
    throw failure("CMS authentication is required.", 401, "CMS_AUTH_REQUIRED");
  }
  await verifySanitySource({
    fetchImpl,
    token,
    operation,
    documentId,
    document,
    sourceRevision,
  });
  await verifySanityMutation({
    fetchImpl,
    token,
    operation,
    documentId,
    document,
  });
};

export const authorizeGlobalCmsMutation = async (options = {}) => {
  const caller = await identifyGlobalCmsUser(options);
  await verifyGlobalCmsMutation({ ...options, caller });
  return caller;
};
