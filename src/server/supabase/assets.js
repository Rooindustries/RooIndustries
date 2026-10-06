import { createSupabaseAdminClient } from "./adminClient.js";

const MANIFEST_TTL_MS = 60 * 1000;
const ASSET_REFERENCE_PATTERN = /^(?:image|file)-[A-Za-z0-9_.-]{1,240}$/;
let manifestCaches = new WeakMap();

const requireData = ({ data, error }, operation) => {
  if (error) {
    const failure = new Error(`Supabase ${operation} failed.`);
    failure.code = error.code || "SUPABASE_ASSET_FAILED";
    throw failure;
  }
  return data;
};

const collectReferences = (
  value,
  result = { ids: new Set(), urls: new Set() },
) => {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectReferences(entry, result));
    return result;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value)) result.urls.add(value);
      else if (ASSET_REFERENCE_PATTERN.test(value)) result.ids.add(value);
    }
    return result;
  }
  const reference = String(value?._ref || "").trim();
  if (reference) result.ids.add(reference);
  Object.values(value).forEach((entry) => collectReferences(entry, result));
  return result;
};

const getManifest = async (client, references) => {
  let manifestCache = manifestCaches.get(client);
  if (!manifestCache) {
    manifestCache = new Map();
    manifestCaches.set(client, manifestCache);
  }
  const now = Date.now();
  for (const [cachedKey, cachedValue] of manifestCache) {
    if (cachedValue.expiresAt <= now) manifestCache.delete(cachedKey);
  }
  const assetIds = [...references.ids].sort().slice(0, 1000);
  const sourceUrls = [...references.urls].sort().slice(0, 1000);
  if (assetIds.length < 1 && sourceUrls.length < 1) {
    return { byId: new Map(), bySourceUrl: new Map() };
  }
  const key = JSON.stringify([assetIds, sourceUrls]);
  const cached = manifestCache.get(key);
  if (cached?.expiresAt > now) return cached.value;
  const data = requireData(
    await client.rpc("roo_asset_manifest_for_refs", {
      p_asset_ids: assetIds,
      p_source_urls: sourceUrls,
    }),
    "asset manifest",
  );
  const entries = Array.isArray(data) ? data : [];
  const manifest = {
    byId: new Map(
      entries.map((entry) => [entry.legacy_sanity_asset_id, entry]),
    ),
    bySourceUrl: new Map(
      entries
        .filter((entry) => entry.source_url)
        .map((entry) => [entry.source_url, entry]),
    ),
  };
  if (manifestCaches.get(client) === manifestCache) {
    if (manifestCache.size >= 100) {
      manifestCache.delete(manifestCache.keys().next().value);
    }
    manifestCache.set(key, { value: manifest, expiresAt: now + MANIFEST_TTL_MS });
  }
  return manifest;
};

const collectEntries = (value, manifest, entries = new Map()) => {
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      const asset = manifest.byId.get(value) || manifest.bySourceUrl.get(value);
      if (asset) entries.set(asset.legacy_sanity_asset_id, asset);
    }
    return entries;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectEntries(entry, manifest, entries));
    return entries;
  }

  const reference = String(value?._ref || "").trim();
  if (reference && manifest.byId.has(reference)) {
    entries.set(reference, manifest.byId.get(reference));
  }
  for (const entry of Object.values(value)) {
    if (typeof entry === "string" && manifest.bySourceUrl.has(entry)) {
      const asset = manifest.bySourceUrl.get(entry);
      entries.set(asset.legacy_sanity_asset_id, asset);
    } else {
      collectEntries(entry, manifest, entries);
    }
  }
  return entries;
};

const resolveUrls = async (entries, client) => {
  const resolved = new Map();
  for (const entry of entries.values()) {
    if (entry.migration_status !== "verified" || !/^[a-f0-9]{64}$/.test(entry.sha256 || "") || !/^(?:images|builds)\/[A-Za-z0-9_.-]+$/.test(entry.storage_path || "")) continue;
    if (entry.storage_bucket === "site-content-public") {
      const data = client.storage
        .from(entry.storage_bucket)
        .getPublicUrl(entry.storage_path).data;
      resolved.set(entry.legacy_sanity_asset_id, data.publicUrl);
      continue;
    }

  }
  return resolved;
};

const missingWarnings = new Set();
const warnMissing = key => {
  if (missingWarnings.has(key) || missingWarnings.size >= 1000) return;
  missingWarnings.add(key);
  console.warn("CMS asset has no verified Supabase copy.");
};
const vendorUrl = value => {
  try { const host = new URL(value).hostname; return host === "sanity.io" || host.endsWith(".sanity.io") || host.endsWith(".sanity.studio"); } catch { return false; }
};
const replaceUrls = (value, manifest, resolved, field = "", assetContext = false) => {
  assetContext ||= /^(iconUrl|fileUrl|imageUrl|_supabaseUrl)$/.test(field);
  if (Array.isArray(value)) {
    return value.map((entry) => replaceUrls(entry, manifest, resolved, field, assetContext));
  }
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    if (!assetContext && !vendorUrl(value)) return value;
    const referencedAsset = manifest.byId.get(value);
    if (referencedAsset) {
      return resolved.get(referencedAsset.legacy_sanity_asset_id) || null;
    }
    const asset = manifest.bySourceUrl.get(value);
    if (asset) return resolved.get(asset.legacy_sanity_asset_id) || null;
    if (vendorUrl(value) || ASSET_REFERENCE_PATTERN.test(value) || (assetContext && /^https?:\/\//i.test(value))) { warnMissing("unmapped"); return null; }
    return value;
  }

  assetContext ||= ["image", "file", "sanity.imageAsset", "sanity.fileAsset"].includes(value._type) || ASSET_REFERENCE_PATTERN.test(value._id || "") || ASSET_REFERENCE_PATTERN.test(value._ref || "") || ASSET_REFERENCE_PATTERN.test(value.asset?._ref || "");
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = key === "_ref" ? entry : replaceUrls(entry, manifest, resolved, key, assetContext);
  }
  const reference = String(value?._ref || "").trim();
  if (reference && ASSET_REFERENCE_PATTERN.test(reference)) {
    delete next._supabaseUrl;
    if (resolved.has(reference)) next._supabaseUrl = resolved.get(reference);
    else warnMissing(reference);
  }
  const linkedAsset = manifest.byId.get(
    String(value?.asset?._ref || "").trim(),
  );
  const width = Number(linkedAsset?.width || 0);
  const height = Number(linkedAsset?.height || 0);
  if (width > 0 && height > 0) {
    next.dimensions = {
      width,
      height,
      aspectRatio: width / height,
    };
  }
  return next;
};

export const enrichSupabaseContentAssets = async ({
  data,
  client = createSupabaseAdminClient(),
} = {}) => {
  const references = collectReferences(data);
  const manifest = await getManifest(client, references);
  const entries = collectEntries(data, manifest);
  const resolved = await resolveUrls(entries, client);
  return replaceUrls(data, manifest, resolved);
};

export const clearSupabaseAssetManifestCache = () => {
  manifestCaches = new WeakMap();
};
