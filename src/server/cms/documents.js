import { CONTENT_TYPES } from "../../lib/cms/contentSchema.js";
import { collectGlobalCmsAssetIds } from "../../lib/globalCmsContract.js";
import { fetchShadowDocuments } from "../supabase/shadowStore.js";
import { cmsError, rpcData, validationError } from "./errors.js";

export const contentType = type => {
  const schema = CONTENT_TYPES.find(schema => schema.name === type);
  if (!schema) throw validationError("$.type", "Choose an editable content type.");
  return schema;
};
export const documentId = id => {
  if (typeof id !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(id) || id.includes("..") || /^(drafts|versions)\./.test(id)) throw validationError("$.documentId", "A published document ID is required.");
  return id;
};
export const loadDocument = async (client, id, types = CONTENT_TYPES.map(type => type.name)) => {
  const rows = await fetchShadowDocuments({ client, ids: [documentId(id)], documentTypes: types, limit: 1, allowLegacyFallback: false });
  return rows[0] || null;
};
export const validManifest = row => row?.migration_status === "verified" && /^[a-f0-9]{64}$/.test(row.sha256 || "") && ((row.legacy_sanity_asset_id?.startsWith("image-") && row.storage_bucket === "site-content-public" && /^images\/[A-Za-z0-9_.-]+$/.test(row.storage_path)) || (row.legacy_sanity_asset_id?.startsWith("file-") && row.storage_bucket === "optimization-builds-private" && /^builds\/[A-Za-z0-9_.-]+$/.test(row.storage_path)));
export const assetSidecar = async (client, document, limit = 500) => {
  const ids = [...new Set((Array.isArray(document) ? document : [document]).flatMap(collectGlobalCmsAssetIds))];
  if (!ids.length) return {};
  if (ids.length > limit) throw validationError("$", "At most 500 assets are supported.");
  const rows = rpcData(await client.rpc("roo_asset_manifest_for_refs", { p_asset_ids: ids, p_source_urls: [] }), "Asset lookup");
  const assets = Object.fromEntries(ids.map(id => [id, { url: null, width: null, height: null, mimeType: null, byteSize: null }]));
  for (const row of rows || []) if (validManifest(row)) {
    assets[row.legacy_sanity_asset_id] = { url: row.storage_bucket === "site-content-public" ? client.storage.from(row.storage_bucket).getPublicUrl(row.storage_path).data.publicUrl : null, width: row.width || null, height: row.height || null, mimeType: row.mime_type, byteSize: Number(row.byte_size) };
  }
  return assets;
};
export const getContentDocument = async (client, id) => {
  const document = await loadDocument(client, id);
  if (!document) throw cmsError("Document not found.", 404, "CMS_NOT_FOUND");
  return { document, revision: document._rev, assets: await assetSidecar(client, document) };
};
const fieldValue = (document, field) => typeof field === "string" ? field.split(".").reduce((value, key) => value?.[key], document) : null;
export const listContentDocuments = async (client, type) => {
  const schema = contentType(type);
  const rows = await fetchShadowDocuments({ client, documentTypes: [type], limit: 1000, allowLegacyFallback: false });
  const documents = [];
  const previewMedia = document => fieldValue(document, schema.preview.media) || document.image || document.icon || document.beforeImage || document.recordImage;
  const assets = await assetSidecar(client, rows.map(document => ({_id:document._id,media:previewMedia(document)})), 1000);
  for (const document of rows) {
    const media = previewMedia(document);
    documents.push({ _id: document._id, _type: document._type, _updatedAt: document._updatedAt, revision: document._rev, preview: { title: String(fieldValue(document, schema.preview.title) || document.title || document.heading || schema.title), subtitle: String(fieldValue(document, schema.preview.subtitle) || ""), imageUrl: assets[media?.asset?._ref]?.url || null } });
  }
  return { documents };
};
export const getContentRevisions = async (client, id) => {
  await getContentDocument(client, id).catch(error => { if (error.status !== 404) throw error; });
  return { revisions: rpcData(await client.rpc("roo_cms_document_revisions", { p_document_id: documentId(id), p_limit: 100 }), "Revision lookup") || [] };
};
export const getContentRevision = async (client, id, revisionId) => {
  documentId(id);
  if (typeof revisionId !== "string" || !/^[a-f0-9-]{36}$/i.test(revisionId)) throw validationError("$.revisionId", "A revision UUID is required.");
  const document = rpcData(await client.rpc("roo_cms_document_revision", { p_revision_id: revisionId }), "Revision lookup");
  if (!document || document._id !== id) throw cmsError("Revision not found.", 404, "CMS_NOT_FOUND");
  contentType(document._type);
  return { document, assets: await assetSidecar(client, document) };
};
