import { loadDocument, validManifest } from "./documents.js";
import { createSupabaseAdminClient } from "../supabase/adminClient.js";
import { CMS_PRIVATE_HEADERS } from "./http.js";
import { rpcData } from "./errors.js";

export const hostedToolDownloadUrl = id => `/api/tools/${encodeURIComponent(id)}/download`;
export const stableToolDownloadLinks = data => Array.isArray(data) ? data.map(tool => ({ ...tool, ...(tool.downloadMode === "hosted" && (tool.fileUrl || tool.downloadFile?.asset?._ref) ? { fileUrl: hostedToolDownloadUrl(tool._id), downloadUrl: hostedToolDownloadUrl(tool._id) } : {}) })) : data;
export const redirectToolDownload = async (request, context) => {
  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 15000);
    const signal = AbortSignal.any([controller.signal, request.signal]);
    const client = createSupabaseAdminClient({ signal });
    const { id } = await context.params;
    const tool = await loadDocument(client, id, ["tool"]);
    const ref = tool?.downloadFile?.asset?._ref;
    if (!tool || tool.downloadMode !== "hosted" || typeof ref !== "string" || !ref.startsWith("file-")) return new Response(null, { status: 404, headers: CMS_PRIVATE_HEADERS });
    const manifest = rpcData(await client.rpc("roo_asset_manifest_for_refs", { p_asset_ids: [ref], p_source_urls: [] }));
    const asset = manifest?.find(row => row.legacy_sanity_asset_id === ref && validManifest(row) && row.storage_bucket === "optimization-builds-private");
    if (!asset) return new Response(null, { status: 404, headers: CMS_PRIVATE_HEADERS });
    const signed = await client.storage.from(asset.storage_bucket).createSignedUrl(asset.storage_path, 900);
    if (signed.error || !signed.data?.signedUrl) return new Response(null, { status: 503, headers: CMS_PRIVATE_HEADERS });
    return new Response(null, { status: 302, headers: { ...CMS_PRIVATE_HEADERS, Location: signed.data.signedUrl } });
  } catch (error) { return new Response(null, { status: error.status === 400 || error.status === 404 ? 404 : 503, headers: CMS_PRIVATE_HEADERS }); }
  finally { clearTimeout(timer); }
};
