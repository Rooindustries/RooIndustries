import crypto from "node:crypto";
import sharp from "sharp";
import { createSupabaseAdminClient } from "../supabase/adminClient.js";
import { cmsError, rpcData, validationError } from "./errors.js";
import { assertGlobalCmsWritesAllowed } from "./writeControl.js";
import { clearSupabaseAssetManifestCache } from "../supabase/assets.js";
import { validManifest } from "./documents.js";

export const CMS_STORAGE_TRANSFER_TIMEOUT_MS = 240000;
export const CMS_UPLOAD_LIMITS = Object.freeze({ image: 20 * 1024 * 1024, file: 64 * 1024 * 1024 });
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"]);
const fileTypes = new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream", "application/vnd.microsoft.portable-executable", "application/x-msdownload"]);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const verifyFailure = message => cmsError(message, 422, "ASSET_VERIFICATION_FAILED");
const logicalStatus = error => Number(error?.statusCode || error?.status || 0);
const missing = error => logicalStatus(error) === 404 || /not found/i.test(String(error?.message));
const storageData = ({ data, error }, operation) => {
  if (!error) return data;
  if (logicalStatus(error) === 413) throw cmsError("Storage refused this file's size.", 413, "ASSET_TOO_LARGE");
  if (logicalStatus(error) === 415) throw cmsError("Storage refused this file type.", 415, "ASSET_TYPE_REFUSED");
  throw cmsError(`${operation} is temporarily unavailable. Retry before the upload expires.`, 503, "ASSET_STORAGE_UNAVAILABLE");
};
const declaration = body => {
  const allowed = new Set(["kind", "fileName", "mimeType", "byteSize", "sha1", "sha256", "width", "height"]);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw validationError("$", "An upload declaration is required.");
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw validationError(`$.${key}`, "Unsupported upload field.");
  if (!["image", "file"].includes(body.kind)) throw validationError("$.kind", "Choose an image or file.");
  if (typeof body.fileName !== "string" || body.fileName.length < 1 || body.fileName.length > 240 || /[\x00-\x1f]/.test(body.fileName)) throw validationError("$.fileName", "A file name of at most 240 characters is required.");
  if (!Number.isSafeInteger(body.byteSize) || body.byteSize < 1) throw validationError("$.byteSize", "A positive byte size is required.");
  if (body.byteSize > CMS_UPLOAD_LIMITS[body.kind]) throw cmsError("This file exceeds the upload limit.", 413, "ASSET_TOO_LARGE");
  if (!(body.kind === "image" ? imageTypes : fileTypes).has(body.mimeType)) throw cmsError("This file type is refused.", 415, "ASSET_TYPE_REFUSED");
  if (typeof body.sha1 !== "string" || !/^[a-f0-9]{40}$/.test(body.sha1)) throw validationError("$.sha1", "A SHA-1 hash is required.");
  if (typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256)) throw validationError("$.sha256", "A SHA-256 hash is required.");
  for (const key of ["width", "height"]) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1 || body[key] > 100000 || body.kind !== "image")) throw validationError(`$.${key}`, "Image dimensions must be positive integers.");
  if ((body.width === undefined) !== (body.height === undefined)) throw validationError("$.width", "Declare both image dimensions or neither.");
  return body;
};
const cleanupExpiredUploads = async (client) => {
  try {
    const rows = rpcData(await client.rpc("roo_expired_cms_uploads", { p_limit: 20 }), "Staging cleanup lookup");
    if (!Array.isArray(rows) || rows.length > 20) throw new Error("Invalid expired upload list");
    for (const row of rows) {
      if (row.staging_bucket !== "cms-upload-staging" || !uuidPattern.test(row.upload_id || "") || row.staging_path !== `uploads/${row.upload_id}` || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) >= Date.now() - 24 * 60 * 60 * 1000) throw new Error("Invalid expired upload identity");
      if (await removeStaging(client, row)) rpcData(await client.rpc("roo_mark_cms_upload_staging_cleaned", { p_upload_id: row.upload_id }), "Staging cleanup checkpoint");
    }
  } catch { console.error("CMS expired staging cleanup needs owner attention", { code: "ASSET_STAGING_CLEANUP_FAILED" }); }
};
export const issueCmsUpload = async ({ body, client, env = process.env, actor = "admin:key", now = Date.now } = {}) => {
  assertGlobalCmsWritesAllowed(env);
  const input = declaration(body);
  await cleanupExpiredUploads(client);
  const prefix = `${input.kind}-${input.sha1}-`;
  const candidates = rpcData(await client.rpc("roo_find_verified_cms_asset", { p_kind: input.kind, p_sha1: input.sha1, p_sha256: input.sha256 }), "Verified asset lookup");
  for (const existing of candidates || []) {
    if (!validManifest(existing) || !existing.legacy_sanity_asset_id.startsWith(prefix) || existing.sha256 !== input.sha256 || Number(existing.byte_size) !== input.byteSize) continue;
    const detected = { extension: existing.legacy_sanity_asset_id.split("-").at(-1), mimeType: existing.mime_type };
    if (!mimeAgrees(input.mimeType, detected)) continue;
    const assetId = existing.legacy_sanity_asset_id;
    const url = input.kind === "image" ? client.storage.from(existing.storage_bucket).getPublicUrl(existing.storage_path).data.publicUrl : null;
    rpcData(await client.rpc("roo_register_verified_cms_asset", { p_asset: { ...existing, source_url: url || `storage://${existing.storage_bucket}/${existing.storage_path}` }, p_asset_document: { _id: assetId, _type: `sanity.${input.kind}Asset`, sha1hash: input.sha1, size: Number(existing.byte_size), mimeType: existing.mime_type, extension: detected.extension, ...(url ? { url } : {}), metadata: input.kind === "image" ? { dimensions: { width: existing.width, height: existing.height, aspectRatio: existing.width / existing.height } } : {} } }), "Verified asset reuse");
    return { uploadId: null, alreadyExists: true, asset: { _type: "reference", _ref: assetId }, assetId, url, width: existing.width, height: existing.height, mimeType: existing.mime_type, byteSize: Number(existing.byte_size) };
  }
  const uploadId = crypto.randomUUID();
  const expiresAt = new Date(now() + 2 * 60 * 60 * 1000).toISOString();
  const row = rpcData(await client.rpc("roo_create_cms_upload", { p_upload: { uploadId, actor, kind: input.kind, fileName: input.fileName, byteSize: input.byteSize, sha1: input.sha1, sha256: input.sha256, mimeType: input.mimeType, width: input.width || null, height: input.height || null, expiresAt } }), "Upload issuance");
  if (row?.upload_id !== uploadId || row.staging_bucket !== "cms-upload-staging" || row.staging_path !== `uploads/${uploadId}` || row.actor !== actor || row.declared_sha1 !== input.sha1 || row.declared_sha256 !== input.sha256 || Number(row.declared_byte_size) !== input.byteSize || row.declared_mime_type !== input.mimeType || row.kind !== input.kind || row.file_name !== input.fileName || row.declared_width !== (input.width || null) || row.declared_height !== (input.height || null) || Date.parse(row.expires_at) !== Date.parse(expiresAt) || row.status !== "issued") throw cmsError("The durable upload declaration disagrees with its request.", 503, "ASSET_UPLOAD_STATE_INVALID");
  const signed = storageData(await client.storage.from(row.staging_bucket).createSignedUploadUrl(row.staging_path, { upsert: false }), "Upload signing");
  if (signed.path !== row.staging_path || typeof signed.signedUrl !== "string" || typeof signed.token !== "string") throw cmsError("The storage signature disagrees with the recorded path.", 503, "ASSET_UPLOAD_STATE_INVALID");
  const signedTarget = new URL(signed.signedUrl);
  const storageOrigin = new URL(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL).origin;
  if (signedTarget.origin !== storageOrigin || signedTarget.pathname !== `/storage/v1/object/upload/sign/${row.staging_bucket}/${row.staging_path}` || signedTarget.searchParams.get("token") !== signed.token) throw cmsError("The upload URL disagrees with its recorded destination.", 503, "ASSET_UPLOAD_STATE_INVALID");
  let signatureExpiresAt = expiresAt;
  try { const expiration = JSON.parse(Buffer.from(signed.token.split('.')[1], 'base64url').toString()).exp; if (!Number.isSafeInteger(expiration) || expiration * 1000 <= now()) throw new Error("Invalid expiry"); signatureExpiresAt = new Date(Math.min(Date.parse(expiresAt), expiration * 1000)).toISOString(); } catch { throw cmsError("Storage returned an invalid upload token.", 503, "ASSET_UPLOAD_STATE_INVALID"); }
  return { uploadId, bucket: row.staging_bucket, path: row.staging_path, signedUrl: signed.signedUrl, token: signed.token, expiresAt: signatureExpiresAt, maxBytes: CMS_UPLOAD_LIMITS[input.kind] };
};
const readBytes = async (client, bucket, path, maxBytes, signal) => {
  const metadata = storageData(await client.storage.from(bucket).info(path), "Object metadata");
  if (metadata.name !== path || metadata.bucketId !== bucket) throw verifyFailure("Stored object metadata disagrees with its requested identity.");
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size < 1) throw verifyFailure("Stored object size is invalid.");
  if (size > maxBytes) throw cmsError("Stored bytes exceed the upload limit.", 413, "ASSET_TOO_LARGE");
  const stream = storageData(await client.storage.from(bucket).download(path, undefined, { signal }).asStream(), "Object download");
  const reader = stream.getReader();
  const chunks = [];
  let byteSize = 0;
  const sha1 = crypto.createHash("sha1"), sha256 = crypto.createHash("sha256");
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      byteSize += part.value.byteLength;
      if (byteSize > maxBytes) { await reader.cancel(); throw cmsError("Streamed bytes exceed the upload limit.", 413, "ASSET_TOO_LARGE"); }
      const chunk = Buffer.from(part.value);
      chunks.push(chunk); sha1.update(chunk); sha256.update(chunk);
    }
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
  if (byteSize !== size) throw verifyFailure("Stored size disagrees with streamed bytes.");
  return { bytes: Buffer.concat(chunks, byteSize), byteSize, sha1: sha1.digest("hex"), sha256: sha256.digest("hex"), storedMimeType: metadata.contentType };
};
const detectBytes = async (bytes, signal) => {
  signal?.throwIfAborted();
  let format;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) format = "png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) format = "jpeg";
  else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) format = "gif";
  else if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") format = "webp";
  else if (bytes.subarray(4, 8).toString("ascii") === "ftyp" && /avif|avis/.test(bytes.subarray(8, 64).toString("ascii"))) format = "heif";
  else if (/^\s*(?:<\?xml[^?]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg\b[^>\[]*>)\s*)*<svg(?:\s|>)/i.test(bytes.subarray(0, 65536).toString("utf8"))) format = "svg";
  else if (bytes.subarray(0, 4).equals(Buffer.from([80,75,3,4])) || bytes.subarray(0, 4).equals(Buffer.from([80,75,5,6]))) return { kind: "file", extension: "zip", mimeType: "application/zip", width: null, height: null };
  else if (bytes[0] === 77 && bytes[1] === 90 && bytes.length >= 64) {
    const offset = bytes.readUInt32LE(60);
    if (offset >= 64 && offset <= bytes.length - 24 && bytes.subarray(offset, offset + 4).equals(Buffer.from([80,69,0,0]))) return { kind: "file", extension: "exe", mimeType: "application/vnd.microsoft.portable-executable", width: null, height: null };
  }
  if (!format) throw verifyFailure("Bytes do not identify an allowed image, ZIP or PE file.");
  let metadata;
  try { metadata = await sharp(bytes, { failOn: "error", limitInputPixels: 100000000 }).timeout({ seconds: 10 }).metadata(); } catch { throw verifyFailure("Image bytes do not parse as the declared format."); }
  if (metadata.format !== format || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width <= 0 || metadata.height <= 0 || metadata.width > 100000 || metadata.height > 100000 || (format === "heif" && metadata.compression !== "av1")) throw verifyFailure("Image format or dimensions are invalid.");
  const { width, height } = metadata.autoOrient;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 100000 || height > 100000) throw verifyFailure("Oriented image dimensions are invalid.");
  return { kind: "image", extension: format === "jpeg" ? "jpg" : format === "heif" ? "avif" : format, mimeType: format === "svg" ? "image/svg+xml" : format === "heif" ? "image/avif" : `image/${format}`, width, height };
};
const mimeAgrees = (declared, detected) => declared === detected.mimeType || (detected.extension === "zip" && declared === "application/x-zip-compressed") || (detected.extension === "exe" && fileTypes.has(declared) && !["application/zip", "application/x-zip-compressed"].includes(declared));
const removeStaging = async (client, row) => {
  const result = await client.storage.from(row.staging_bucket).remove([row.staging_path]);
  if (result.error && !missing(result.error)) console.error("CMS staging cleanup unavailable", { code: "ASSET_STAGING_CLEANUP_FAILED" });
  return !result.error || missing(result.error);
};
const finalizeUpload = async ({ body, client, env = process.env, actor = "admin:key", signal, now = Date.now } = {}) => {
  assertGlobalCmsWritesAllowed(env);
  signal = AbortSignal.any([AbortSignal.timeout(210000), ...(signal ? [signal] : [])]);
  if (!body || Object.keys(body).length !== 1 || typeof body.uploadId !== "string" || !uuidPattern.test(body.uploadId)) throw validationError("$.uploadId", "The recorded upload UUID is required.");
  const row = rpcData(await client.rpc("roo_get_cms_upload", { p_upload_id: body.uploadId }), "Upload lookup");
  if (!row || row.actor !== actor || row.upload_id !== body.uploadId || row.staging_bucket !== "cms-upload-staging" || row.staging_path !== `uploads/${body.uploadId}` || !["image", "file"].includes(row.kind)) throw verifyFailure("The recorded upload identity is invalid.");
  if (row.status === "completed") { await removeStaging(client, row); return row.result; }
  if (row.status !== "issued" || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now()) throw verifyFailure("The upload has expired or was refused.");
  const maxBytes = CMS_UPLOAD_LIMITS[row.kind];
  const transferClient = createSupabaseAdminClient({ env, signal, storageTransferTimeoutMs: CMS_STORAGE_TRANSFER_TIMEOUT_MS });
  let upload, detected;
  try {
    upload = await readBytes(transferClient, row.staging_bucket, row.staging_path, maxBytes, signal);
    detected = await detectBytes(upload.bytes, signal);
    if (upload.byteSize !== Number(row.declared_byte_size) || upload.sha1 !== row.declared_sha1 || upload.sha256 !== row.declared_sha256 || detected.kind !== row.kind || !mimeAgrees(row.declared_mime_type, detected) || upload.storedMimeType !== row.declared_mime_type || (row.declared_width !== null && row.declared_width !== undefined && Number(row.declared_width) !== detected.width) || (row.declared_height !== null && row.declared_height !== undefined && Number(row.declared_height) !== detected.height)) throw verifyFailure("Stored bytes disagree with the upload declaration.");
  } catch (error) {
    if (["ASSET_VERIFICATION_FAILED", "ASSET_TOO_LARGE"].includes(error.code)) {
      rpcData(await client.rpc("roo_refuse_cms_upload", { p_upload_id: row.upload_id, p_error_code: error.code }), "Upload refusal");
      await removeStaging(client, row);
    }
    throw error;
  }
  const { width, height, mimeType, extension } = detected;
  const candidates = rpcData(await client.rpc("roo_find_verified_cms_asset", { p_kind: row.kind, p_sha1: upload.sha1, p_sha256: upload.sha256 }), "Verified asset lookup");
  const registered = (candidates || []).find(candidate => validManifest(candidate) && candidate.legacy_sanity_asset_id.startsWith(`${row.kind}-${upload.sha1}-`) && candidate.sha256 === upload.sha256 && Number(candidate.byte_size) === upload.byteSize && candidate.mime_type === mimeType);
  const assetId = registered?.legacy_sanity_asset_id || (row.kind === "image" ? `image-${upload.sha1}-${width}x${height}-${extension}` : `file-${upload.sha1}-${extension}`);
  const dimensions = registered ? { width: registered.width, height: registered.height } : { width, height };
  const bucket = row.kind === "image" ? "site-content-public" : "optimization-builds-private";
  const path = `${row.kind === "image" ? "images" : "builds"}/${upload.sha1}.${extension}`;
  let reused = false;
  const existing = await client.storage.from(bucket).info(path);
  if (existing.error && !missing(existing.error)) storageData(existing, "Final object lookup");
  if (!existing.error) reused = true;
  if (!reused) {
    const promotion = await transferClient.storage.from(bucket).upload(path, upload.bytes, { contentType: mimeType, upsert: false });
    if (promotion.error && logicalStatus(promotion.error) !== 409) storageData(promotion, "Asset promotion");
    if (promotion.error) reused = true;
  }
  try {
    const final = await readBytes(transferClient, bucket, path, maxBytes, signal);
    const finalType = await detectBytes(final.bytes, signal);
    if (final.sha256 !== upload.sha256 || final.sha1 !== upload.sha1 || final.byteSize !== upload.byteSize || final.storedMimeType !== mimeType || JSON.stringify(finalType) !== JSON.stringify(detected)) throw verifyFailure("Final bytes disagree.");
  } catch (error) {
    if (!["ASSET_VERIFICATION_FAILED", "ASSET_TOO_LARGE"].includes(error.code)) throw error;
    console.error("CMS immutable asset mismatch", { code: "ASSET_FINAL_COLLISION" });
    rpcData(await client.rpc("roo_refuse_cms_upload", { p_upload_id: row.upload_id, p_error_code: "ASSET_FINAL_COLLISION" }), "Upload collision refusal");
    throw verifyFailure("The immutable final asset disagrees with these bytes. Owner attention is required.");
  }
  const url = row.kind === "image" ? client.storage.from(bucket).getPublicUrl(path).data.publicUrl : null;
  const manifest = { legacy_sanity_asset_id: assetId, asset_kind: row.kind, storage_bucket: bucket, storage_path: path, source_url: url || `storage://${bucket}/${path}`, mime_type: mimeType, byte_size: upload.byteSize, sha256: upload.sha256, ...dimensions, migration_status: "verified", verified_at: new Date(now()).toISOString(), metadata: {} };
  const assetDocument = { _id: assetId, _type: `sanity.${row.kind}Asset`, ...(url ? { url } : {}), sha1hash: upload.sha1, size: upload.byteSize, mimeType, extension, metadata: row.kind === "image" ? { dimensions: { ...dimensions, aspectRatio: dimensions.width / dimensions.height } } : {} };
  const registration = await client.rpc("roo_register_verified_cms_asset", { p_asset: manifest, p_asset_document: assetDocument });
  if (registration.error?.message?.includes("CMS_ASSET_SOURCE_COLLISION")) {
    console.error("CMS verified asset source mismatch", { code: "CMS_ASSET_SOURCE_COLLISION" });
    rpcData(await client.rpc("roo_refuse_cms_upload", { p_upload_id: row.upload_id, p_error_code: "CMS_ASSET_SOURCE_COLLISION" }), "Asset source collision refusal");
    await removeStaging(client, row);
    rpcData(registration, "Verified asset registration");
  }
  if (registration.error?.message?.includes("CMS_ASSET_COLLISION")) {
    console.error("CMS verified asset registry mismatch", { code: "ASSET_REGISTRY_COLLISION" });
    rpcData(await client.rpc("roo_refuse_cms_upload", { p_upload_id: row.upload_id, p_error_code: "ASSET_REGISTRY_COLLISION" }), "Asset collision refusal");
    throw verifyFailure("The verified asset registry disagrees with these bytes. Owner attention is required.");
  }
  rpcData(registration, "Verified asset registration");
  const result = { asset: { _type: "reference", _ref: assetId }, assetId, url, ...dimensions, mimeType, byteSize: upload.byteSize, sha256: upload.sha256, reused };
  const completed = await client.rpc("roo_complete_cms_upload", { p_upload_id: row.upload_id, p_result: result });
  let saved;
  if (completed.error?.code === "23505") {
    const latest = rpcData(await client.rpc("roo_get_cms_upload", { p_upload_id: row.upload_id }), "Upload replay");
    if (latest?.status !== "completed" || latest.asset_id !== assetId) rpcData(completed, "Upload completion");
    saved = latest;
  } else saved = rpcData(completed, "Upload completion");
  await removeStaging(client, row);
  clearSupabaseAssetManifestCache();
  return saved.result;
};

export const finalizeCmsUpload = async (input = {}) => {
  try { return await finalizeUpload(input); }
  catch (error) {
    if (["ASSET_VERIFICATION_FAILED", "ASSET_TOO_LARGE", "CMS_ASSET_SOURCE_COLLISION", "CMS_VALIDATION_FAILED", "CMS_WRITES_PAUSED", "CMS_WRITE_CONTROL_INVALID"].includes(error.code)) throw error;
    if (uuidPattern.test(input.body?.uploadId || "")) {
      try {
        const client = input.signal?.aborted ? createSupabaseAdminClient({ env: input.env || process.env, signal: AbortSignal.timeout(5000) }) : input.client;
        const state = rpcData(await client.rpc("roo_record_cms_upload_failure", { p_upload_id: input.body.uploadId, p_error_code: error.code && /^[A-Z][A-Z0-9_]{1,127}$/.test(error.code) ? error.code : "ASSET_STORAGE_UNAVAILABLE" }), "Upload retry checkpoint");
        if (state.status === "refused") console.error("CMS upload needs owner attention", { code: "ASSET_RETRY_EXHAUSTED" });
      } catch { console.error("CMS upload retry checkpoint failed", { code: "ASSET_RETRY_CHECKPOINT_FAILED" }); }
    }
    throw error;
  }
};
