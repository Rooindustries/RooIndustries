import { createClient as createSanityClient } from "@sanity/client";
import {
  PUBLIC_CONTENT_QUERIES,
  PUBLIC_CONTENT_RESOURCES,
} from "../../lib/publicContentQueries";
import { createSupabaseDocumentClient } from "../supabase/documentClient.js";
import { enrichSupabaseContentAssets } from "../supabase/assets.js";
import { resolveSupabaseRuntimePolicy } from "../supabase/runtime.js";
import { resolveGlobalSanityReadConfig } from "../cms/globalSanityConfig.js";

const DEFAULT_API_VERSION = "2026-06-09";
const SUPABASE_CONTENT_CACHE_TTL_MS = 60 * 1000;
const SUPABASE_CONTENT_STALE_TTL_MS = 10 * 60 * 1000;
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

const createPublicContentClient = ({ backend, resource }) => {
  if (backend === "supabase") {
    const assetDocumentTypes = ASSET_DEREFERENCE_RESOURCES.has(resource)
      ? ["sanity.imageAsset", "sanity.fileAsset"]
      : [];
    return createSupabaseDocumentClient({
      documentTypes: [
        ...(DOCUMENT_TYPES_BY_RESOURCE[resource] || []),
        ...assetDocumentTypes,
      ],
    });
  }

  const config = resolveGlobalSanityReadConfig(process.env);
  if (!config) {
    throw new Error("Sanity public content access is not configured.");
  }
  const { token, ...target } = config;
  return createSanityClient({
    ...target,
    apiVersion: config.apiVersion || DEFAULT_API_VERSION,
    ...(token ? { token } : {}),
    useCdn: !token,
    perspective: "published",
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
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) {
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

const loadSupabasePublicContent = async ({ resource, query, params }) => {
  if (Object.keys(params).length > 0) {
    const data = await createPublicContentClient({
      backend: "supabase",
      resource,
    }).fetch(query, params);
    return enrichSupabaseContentAssets({ data });
  }

  const key = `${resource}:${JSON.stringify(params)}`;
  const now = Date.now();
  const cached = supabaseContentCache.get(key);
  if (cached?.hasData && cached.expiresAt > now) return cached.data;
  if (cached?.pending) return cached.pending;

  const pending = createPublicContentClient({ backend: "supabase", resource })
    .fetch(query, params)
    .then((data) => enrichSupabaseContentAssets({ data }))
    .then((data) => {
      supabaseContentCache.set(key, {
        data,
        hasData: true,
        expiresAt: Date.now() + SUPABASE_CONTENT_CACHE_TTL_MS,
        staleUntil: Date.now() + SUPABASE_CONTENT_STALE_TTL_MS,
      });
      return data;
    })
    .catch((error) => {
      if (cached?.hasData && cached.staleUntil > Date.now()) {
        supabaseContentCache.set(key, {
          ...cached,
          expiresAt: Date.now() + SUPABASE_CONTENT_RETRY_TTL_MS,
          pending: null,
        });
        return cached.data;
      }
      supabaseContentCache.delete(key);
      throw error;
    });

  supabaseContentCache.set(key, { ...cached, pending });
  return pending;
};

export const clearSupabasePublicContentCache = () => {
  supabaseContentCache.clear();
};

export const fetchPublicContent = async ({
  resource,
  searchParams,
  backend = "",
}) => {
  const query = PUBLIC_CONTENT_QUERIES[resource];
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
  const selectedBackend =
    backend === "sanity" || backend === "supabase"
      ? backend
      : resolveSupabaseRuntimePolicy().primaryBackend;
  if (selectedBackend === "supabase") {
    return loadSupabasePublicContent({ resource, query, params });
  }
  return createPublicContentClient({ backend: selectedBackend, resource }).fetch(
    query,
    params
  );
};
