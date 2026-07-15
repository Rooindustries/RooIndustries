import crypto from "node:crypto";
import { createClient as createSanityClient } from "@sanity/client";
import {
  GLOBAL_SANITY_DATASET,
  GLOBAL_SANITY_PROJECT_ID,
  collectGlobalCmsAssetLinks,
  globalCmsAuthorityDomain,
  isGlobalCmsEditableType,
  normalizeGlobalCmsAssetManifest,
  normalizeGlobalCmsDocument,
  publishedDocumentId,
  stableCmsJson,
} from "../../lib/globalCmsContract.js";
import { clearSupabasePublicContentCache } from "../content/publicContent.js";
import { logSafeError } from "../safeErrorLog.js";
import { drainDocumentMutationOutbox } from "../supabase/documentMutationOutbox.js";
import { drainCommerceMirrorOutbox } from "../supabase/commerceMirrorOutbox.js";
import { fetchShadowDocuments } from "../supabase/shadowStore.js";
import { prepareGlobalCmsAssets } from "./assets.js";
import {
  identifyGlobalCmsUser,
  verifyGlobalCmsMutation,
} from "./sanityAuthorization.js";
import { resolveGlobalSanityWriteConfig } from "./globalSanityConfig.js";
import { assertGlobalCmsWritesAllowed } from "./writeControl.js";

const OPERATIONS = new Set(["delete", "publish", "unpublish"]);

const failure = (message, status, code) => {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  error.code = code;
  return error;
};

const requireRpcData = ({ data, error }, operation) => {
  if (!error) return data;
  const statusByCode = {
    22023: 400,
    23505: 409,
    40001: 409,
    P0002: 404,
  };
  throw failure(
    `Supabase ${operation} failed.`,
    statusByCode[error.code] || 503,
    error.code || "CMS_DATABASE_FAILED",
  );
};

const readPrivateSanityConfig = (env) => {
  const target = resolveGlobalSanityWriteConfig(env);
  if (!target) return null;
  return {
    projectId: target.projectId,
    dataset: target.dataset,
    token: target.token,
    apiVersion: target.apiVersion || "2026-07-01",
    useCdn: false,
    perspective: "raw",
  };
};

const asClientValidation = (callback, code) => {
  try {
    return callback();
  } catch (error) {
    throw failure(
      error instanceof Error ? error.message : "The CMS command is invalid.",
      400,
      code,
    );
  }
};

const parseRequest = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw failure("A CMS command is required.", 400, "CMS_COMMAND_INVALID");
  }
  if (
    String(body.projectId || "") !== GLOBAL_SANITY_PROJECT_ID ||
    String(body.dataset || "") !== GLOBAL_SANITY_DATASET
  ) {
    throw failure(
      "The CMS command target is invalid.",
      400,
      "CMS_TARGET_INVALID",
    );
  }
  const operation = String(body.operation || "")
    .trim()
    .toLowerCase();
  const type = String(body.type || body.document?._type || "").trim();
  if (!OPERATIONS.has(operation) || !isGlobalCmsEditableType(type)) {
    throw failure(
      "The CMS command is not supported.",
      400,
      "CMS_COMMAND_UNSUPPORTED",
    );
  }
  const documentId = asClientValidation(
    () => publishedDocumentId(body.documentId || body.document?._id),
    "CMS_DOCUMENT_ID_INVALID",
  );
  const sourceRevision = String(body.sourceRevision || "").trim();
  if (sourceRevision.length > 128) {
    throw failure(
      "The CMS source revision is invalid.",
      400,
      "CMS_REVISION_INVALID",
    );
  }
  if (body.assetManifest !== undefined && !Array.isArray(body.assetManifest)) {
    throw failure(
      "The CMS asset manifest is invalid.",
      400,
      "CMS_ASSET_MANIFEST_INVALID",
    );
  }
  if (operation !== "publish") {
    if (Array.isArray(body.assetManifest) && body.assetManifest.length > 0) {
      throw failure(
        "Delete commands cannot include assets.",
        400,
        "CMS_ASSET_UNEXPECTED",
      );
    }
    return {
      operation,
      type,
      documentId,
      sourceRevision,
      document: null,
      assetManifest: [],
    };
  }
  const document = asClientValidation(
    () => normalizeGlobalCmsDocument({
      document: body.document,
      id: documentId,
      type,
    }),
    "CMS_DOCUMENT_INVALID",
  );
  return {
    operation,
    type,
    documentId,
    sourceRevision,
    document,
    assetManifest: normalizeGlobalCmsAssetManifest(body.assetManifest),
  };
};

const hashCommand = (value) =>
  crypto.createHash("sha256").update(stableCmsJson(value)).digest("hex");

const loadCurrentDocument = async ({ client, command }) => {
  const documents = await fetchShadowDocuments({
    client,
    documentTypes: [command.type],
    ids: [command.documentId],
    limit: 1,
    allowLegacyFallback: false,
  });
  const current = documents[0] || null;
  if (current && current._type !== command.type) {
    throw failure(
      "The CMS document type changed.",
      409,
      "CMS_DOCUMENT_TYPE_CONFLICT",
    );
  }
  return current;
};

const buildMutations = ({ command, current }) => {
  if (command.operation !== "publish") {
    if (!current) {
      throw failure(
        "The CMS authority is missing the document to delete.",
        409,
        "CMS_AUTHORITY_MISSING",
      );
    }
    return [
      {
        operation: "delete",
        id: command.documentId,
        expected_revision: current._rev || "",
      },
    ];
  }
  return [
    current
      ? {
          operation: "replace",
          id: command.documentId,
          expected_revision: current._rev || "",
          document: command.document,
        }
      : {
          operation: "create",
          id: command.documentId,
          document: command.document,
        },
  ];
};

const readRequiredMirrorStatus = async ({ client, documentId }) =>
  requireRpcData(
    await client.rpc("roo_document_mutation_mirror_status_for_ids", {
      p_document_ids: [documentId],
    }),
    "CMS mirror status",
  ) || {};

const readRequiredCommerceMirrorStatus = async ({ client, documentId }) =>
  requireRpcData(
    await client.rpc("roo_commerce_mirror_status_for_ids", {
      p_document_ids: [documentId],
    }),
    "CMS commerce mirror status",
  ) || {};

const trySynchronousMirror = async ({
  client,
  documentId,
  env,
  sanityClientFactory,
  drainMirror,
  domain,
}) => {
  const config = readPrivateSanityConfig(env);
  if (config) {
    await drainMirror({
      supabaseClient: client,
      sanityClient: sanityClientFactory(config),
      requiredDocumentIds: [documentId],
      limit: 5,
      maxBatches: 2,
      budgetMs: 8_000,
    });
  }
  return domain === "commerce"
    ? readRequiredCommerceMirrorStatus({ client, documentId })
    : readRequiredMirrorStatus({ client, documentId });
};

export const executeGlobalCmsCommand = async ({
  body,
  authorization,
  supabaseClient,
  env = process.env,
  fetchImpl = fetch,
  sanityClientFactory = createSanityClient,
  identifyCaller = identifyGlobalCmsUser,
  verifyMutation = verifyGlobalCmsMutation,
  prepareAssets = prepareGlobalCmsAssets,
  drainContentMirror = drainDocumentMutationOutbox,
  drainCommerceMirror = drainCommerceMirrorOutbox,
} = {}) => {
  assertGlobalCmsWritesAllowed(env);
  const command = parseRequest(body);
  const domain = globalCmsAuthorityDomain(command.type);
  const caller = await identifyCaller({
    authorization,
    fetchImpl,
  });
  const requestMaterial = {
    actor: caller.actor,
    assetManifest: command.assetManifest,
    document: command.document,
    documentId: command.documentId,
    operation: command.operation,
    projectId: GLOBAL_SANITY_PROJECT_ID,
    dataset: GLOBAL_SANITY_DATASET,
    sourceRevision: command.sourceRevision,
    type: command.type,
  };
  const requestHash = hashCommand(requestMaterial);
  const commandId = `cms:${requestHash}`;
  const finishCommitted = async (replayed) => {
    clearSupabasePublicContentCache();
    let syncPending = true;
    try {
      const mirrorStatus = await trySynchronousMirror({
        client: supabaseClient,
        documentId: command.documentId,
        env,
        sanityClientFactory,
        drainMirror:
          domain === "commerce" ? drainCommerceMirror : drainContentMirror,
        domain,
      });
      syncPending =
        Number(mirrorStatus?.pending || 0) > 0 ||
        Number(mirrorStatus?.dead_letters || 0) > 0;
    } catch (error) {
      logSafeError("CMS fallback mirror remains pending", error);
    }
    return {
      commandId,
      committed: true,
      documentId: command.documentId,
      operation: command.operation,
      replayed,
      syncPending,
    };
  };
  const existing = requireRpcData(
    await supabaseClient.rpc("roo_cms_publish_command_result", {
      p_command_id: commandId,
      p_request_hash: requestHash,
      p_actor: caller.actor,
    }),
    "CMS receipt lookup",
  );
  if (existing?.replayed === true) return finishCommitted(true);

  await verifyMutation({
    caller,
    operation: command.operation === "publish" ? "publish" : "delete",
    documentId: command.documentId,
    document: command.document,
    sourceRevision: command.sourceRevision,
    fetchImpl,
  });
  const assets =
    command.operation === "publish"
      ? await prepareAssets({
          document: command.document,
          suppliedManifest: command.assetManifest,
          token: caller.token,
          supabaseClient,
          fetchImpl,
          sanityClientFactory,
        })
      : [];
  const current = await loadCurrentDocument({
    client: supabaseClient,
    command,
  });
  const mutations = buildMutations({ command, current });
  const assetLinks = command.document
    ? collectGlobalCmsAssetLinks(command.document)
    : [];
  const result = requireRpcData(
    await supabaseClient.rpc("roo_apply_cms_publish_command", {
      p_command_id: commandId,
      p_request_hash: requestHash,
      p_actor: caller.actor,
      p_mutations: mutations,
      p_assets: assets,
      p_asset_links: assetLinks,
    }),
    "CMS publish command",
  );
  return finishCommitted(result?.replayed === true);
};
