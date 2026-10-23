import { stableToolDownloadLinks } from "../cms/toolDownload.js";
import {
  PUBLIC_CONTENT_QUERIES,
  PUBLIC_CONTENT_RESOURCES,
} from "../../lib/publicContentQueries";
import { createSupabaseDocumentClient } from "../supabase/documentClient.js";
import { createSupabaseAdminClient } from "../supabase/adminClient.js";
import { assertPublicContentShape } from "./publicContentShape.js";
import { clearSupabaseAssetManifestCache, enrichSupabaseContentAssets } from "../supabase/assets.js";
import policyContent from "../../lib/policyContent";
import { UPGRADE_LINK_SLUG_PATTERN } from "../../lib/globalCmsContract.js";
import { logSafeError } from "../safeErrorLog.js";

const { applyPublicPolicyOverrides } = policyContent;

const SUPABASE_CONTENT_CACHE_TTL_MS = 60 * 1000;
const SUPABASE_CONTENT_RETRY_TTL_MS = 5 * 1000;
const supabaseContentCache = new Map();

const DOCUMENT_TYPES_BY_RESOURCE = Object.freeze({
  reviews: ["proReviewsCarousel"],
  about: ["about"],
  services: ["services"],
  "packages-list": ["package"],
  "packages-settings": ["packagesSettings"],
  "how-it-works": ["howItWorks"],
  "supported-games": ["supportedGames"],
  "faq-settings": ["faqSettings"],
  "faq-questions": ["faqSection"],
  hero: ["hero"],
  team: ["meetTheTeam"],
  contact: ["contact"],
  tools: ["tool"],
  benchmarks: ["benchmark"],
  "discord-banner": ["discordBanner"],
  terms: ["terms"],
  "privacy-policy": ["privacyPolicy"],
  "reviews-gallery": ["review"],
  "referral-box": ["referralBox"],
  package: ["package"],
  "upgrade-link": ["upgradeLink", "package"],
});
const ASSET_DEREFERENCE_RESOURCES = new Set(["tools"]);

const createPublicContentClient = ({ resource, client }) => {
  const assetDocumentTypes = ASSET_DEREFERENCE_RESOURCES.has(resource)
    ? ["sanity.imageAsset", "sanity.fileAsset"]
    : [];
  return createSupabaseDocumentClient({
    shadowClient: client,
    documentTypes: [
      ...(DOCUMENT_TYPES_BY_RESOURCE[resource] || []),
      ...assetDocumentTypes,
    ],
  });
};

const parseTitles = (searchParams) => {
  const raw = searchParams.getAll("title").flatMap((value) => value.split(","));
  const titles = [...new Set(raw.map((value) => value.trim()).filter(Boolean))];
  if (
    titles.length < 1 ||
    titles.length > 8 ||
    titles.some((value) => value.length > 100)
  ) {
    const error = new Error("A valid package title is required.");
    error.status = 400;
    throw error;
  }
  return titles;
};

const parseSlug = (searchParams) => {
  const slug = String(searchParams.get("slug") || "")
    .trim()
    .toLowerCase();
  if (!UPGRADE_LINK_SLUG_PATTERN.test(slug)) {
    const error = new Error("A valid upgrade slug is required.");
    error.status = 400;
    throw error;
  }
  return slug;
};

export { PUBLIC_CONTENT_RESOURCES };

const validateAllowedParameters = (resource, searchParams) => {
  const allowed = new Set(
    resource === "package"
      ? ["title"]
      : resource === "upgrade-link"
        ? ["slug"]
        : [],
  );
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      const error = new Error("Unsupported content parameter.");
      error.status = 400;
      throw error;
    }
  }
  if (resource === "upgrade-link" && searchParams.getAll("slug").length !== 1) {
    const error = new Error("A single upgrade slug is required.");
    error.status = 400;
    throw error;
  }
};

export const loadSupabasePublicContent = async ({ resource, query, params, fresh = false, allowFallback = true }) => {
  const fallbackAllowed = allowFallback && process.env.NEXT_PHASE !== "phase-production-build";
  const load = async () => {
    const client = createSupabaseAdminClient({
      signal: AbortSignal.timeout(5000),
      fetchImpl: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    });
    const data = await createPublicContentClient({ resource, client }).fetch(query, params);
    if (resource === "tools" && Array.isArray(data)) {
      for (const tool of data) {
        for (const field of ["downloadUrl", "officialSite"]) if (typeof tool?.[field] === "string") tool[field] = tool[field].trim();
      }
    }
    assertPublicContentShape(resource, data, DOCUMENT_TYPES_BY_RESOURCE[resource][0]);
    return enrichSupabaseContentAssets({ data, client });
  };
  if (Object.keys(params).length > 0) {
    return load();
  }

  const key = `${resource}:${JSON.stringify(params)}`;
  const now = Date.now();
  const cached = supabaseContentCache.get(key);
  if (!fresh && cached?.hasData && cached.expiresAt > now) return cached.data;
  if (!fresh && cached?.pending) return cached.pending;

  const pending = load()
    .then((data) => {
      if (supabaseContentCache.get(key)?.pending !== pending) return data;
      supabaseContentCache.set(key, {
        data,
        hasData: true,
        expiresAt: Date.now() + SUPABASE_CONTENT_CACHE_TTL_MS,
      });
      return data;
    })
    .catch(async (error) => {
      const current = supabaseContentCache.get(key);
      const retained = current?.hasData ? current : cached;
      if (fallbackAllowed && retained?.hasData) {
        if (supabaseContentCache.get(key)?.pending === pending) {
          supabaseContentCache.set(key, {
            ...retained,
            expiresAt: Date.now() + SUPABASE_CONTENT_RETRY_TTL_MS,
            pending: null,
          });
        }
        return retained.data;
      }
      if (fallbackAllowed && process.env.NODE_ENV === "production") {
        try {
          const { default: snapshot } = await import("../../generated/public-content.json", { with: { type: "json" } });
          if (snapshot.version !== 1 || !snapshot.resources || !Object.hasOwn(snapshot.resources, resource)) throw new Error("The build content snapshot is invalid.");
          const data = snapshot.resources[resource];
          assertPublicContentShape(resource, data, DOCUMENT_TYPES_BY_RESOURCE[resource][0]);
          const current = supabaseContentCache.get(key);
          if (current?.hasData) return current.data;
          if (supabaseContentCache.get(key)?.pending === pending) {
            supabaseContentCache.set(key, { data, hasData: true, expiresAt: Date.now() + SUPABASE_CONTENT_RETRY_TTL_MS });
          }
          logSafeError("Public content read failed; using build content", error);
          return data;
        } catch (snapshotError) {
          logSafeError("Public content build fallback failed", snapshotError);
        }
      }
      if (supabaseContentCache.get(key)?.pending === pending) supabaseContentCache.delete(key);
      throw error;
    });

  supabaseContentCache.set(key, { ...cached, pending });
  return pending;
};

export const clearSupabasePublicContentCache = ({ preserveStale = false } = {}) => {
  if (preserveStale) {
    for (const [key, cached] of supabaseContentCache) {
      if (cached.hasData) supabaseContentCache.set(key, { ...cached, expiresAt: 0, pending: null });
      else supabaseContentCache.delete(key);
    }
  } else supabaseContentCache.clear();
  clearSupabaseAssetManifestCache();
};

export const fetchPublicContent = async ({
  resource,
  searchParams,
  fresh = false,
}) => {
  const query = Object.hasOwn(PUBLIC_CONTENT_QUERIES, resource) ? PUBLIC_CONTENT_QUERIES[resource] : null;
  if (!query) {
    const error = new Error("Public content resource was not found.");
    error.status = 404;
    throw error;
  }
  validateAllowedParameters(resource, searchParams);

  const params =
    resource === "package"
      ? { titles: parseTitles(searchParams) }
      : resource === "upgrade-link"
        ? { slug: parseSlug(searchParams) }
        : {};
  const data = await loadSupabasePublicContent({ resource, query, params, fresh });
  return applyPublicPolicyOverrides(resource, resource === "tools" ? stableToolDownloadLinks(data) : data);
};
