import { createSupabaseAdminClient } from "./adminClient.js";

const MANIFEST_TTL_MS = 60 * 1000;
const PRIVATE_URL_TTL_SECONDS = 15 * 60;
let manifestCache = null;
let manifestExpiresAt = 0;

const requireData = ({ data, error }, operation) => {
  if (error) {
    const failure = new Error(`Supabase ${operation} failed.`);
    failure.code = error.code || "SUPABASE_ASSET_FAILED";
    throw failure;
  }
  return data;
};

const getManifest = async (client) => {
  if (manifestCache && manifestExpiresAt > Date.now()) return manifestCache;
  const data = requireData(
    await client.rpc("roo_asset_manifest"),
    "asset manifest"
  );
  const entries = Array.isArray(data) ? data : [];
  manifestCache = {
    byId: new Map(
      entries.map((entry) => [entry.legacy_sanity_asset_id, entry])
    ),
    bySourceUrl: new Map(
      entries
        .filter((entry) => entry.source_url)
        .map((entry) => [entry.source_url, entry])
    ),
  };
  manifestExpiresAt = Date.now() + MANIFEST_TTL_MS;
  return manifestCache;
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
  const manifest = await getManifest(client);
  const entries = collectEntries(data, manifest);
  if (entries.size < 1) return data;
  const resolved = await resolveUrls(entries, client);
  return replaceUrls(data, manifest, resolved);
};

export const clearSupabaseAssetManifestCache = () => {
  manifestCache = null;
  manifestExpiresAt = 0;
};
