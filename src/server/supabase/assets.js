import { createSupabaseAdminClient } from "./adminClient.js";

const MANIFEST_TTL_MS = 60 * 1000;
const PRIVATE_URL_TTL_SECONDS = 15 * 60;
const manifestCache = new Map();

const requireData = ({ data, error }, operation) => {
  if (error) {
    const failure = new Error(`Supabase ${operation} failed.`);
    failure.code = error.code || "SUPABASE_ASSET_FAILED";
    throw failure;
  }
  return data;
};

const collectReferences = (value, result = { ids: new Set(), urls: new Set() }) => {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectReferences(entry, result));
    return result;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      result.urls.add(value);
    }
    return result;
  }
  const reference = String(value?._ref || "").trim();
  if (reference) result.ids.add(reference);
  Object.values(value).forEach((entry) => collectReferences(entry, result));
  return result;
};

const getManifest = async (client, references) => {
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
    "asset manifest"
  );
  const entries = Array.isArray(data) ? data : [];
  const manifest = {
    byId: new Map(
      entries.map((entry) => [entry.legacy_sanity_asset_id, entry])
    ),
    bySourceUrl: new Map(
      entries
        .filter((entry) => entry.source_url)
        .map((entry) => [entry.source_url, entry])
    ),
  };
  if (manifestCache.size >= 100) {
    manifestCache.delete(manifestCache.keys().next().value);
  }
  manifestCache.set(key, { value: manifest, expiresAt: now + MANIFEST_TTL_MS });
  return manifest;
};

const collectEntries = (value, manifest, entries = new Map()) => {
  if (!value || typeof value !== "object") return entries;
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
    if (entry.storage_bucket === "site-content-public") {
      const data = client.storage
        .from(entry.storage_bucket)
        .getPublicUrl(entry.storage_path).data;
      resolved.set(entry.legacy_sanity_asset_id, data.publicUrl);
      continue;
    }

    const data = requireData(
      await client.storage
        .from(entry.storage_bucket)
        .createSignedUrl(entry.storage_path, PRIVATE_URL_TTL_SECONDS),
      "private asset signing"
    );
    resolved.set(entry.legacy_sanity_asset_id, data.signedUrl);
  }
  return resolved;
};

const replaceUrls = (value, manifest, resolved) => {
  if (Array.isArray(value)) {
    return value.map((entry) => replaceUrls(entry, manifest, resolved));
  }
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    const asset = manifest.bySourceUrl.get(value);
    return asset
      ? resolved.get(asset.legacy_sanity_asset_id) || value
      : value;
  }

  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = replaceUrls(entry, manifest, resolved);
  }
  const reference = String(value?._ref || "").trim();
  if (reference && resolved.has(reference)) {
    next._supabaseUrl = resolved.get(reference);
  }
  const linkedAsset = manifest.byId.get(
    String(value?.asset?._ref || "").trim()
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
  if (entries.size < 1) return data;
  const resolved = await resolveUrls(entries, client);
  return replaceUrls(data, manifest, resolved);
};

export const clearSupabaseAssetManifestCache = () => {
  manifestCache.clear();
};
