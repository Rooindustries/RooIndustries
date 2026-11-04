import { stableToolDownloadLinks } from "../cms/toolDownload.js";
import {
  PUBLIC_CONTENT_QUERIES,
  PUBLIC_CONTENT_RESOURCES,
} from "../../lib/publicContentQueries";
import { createSupabaseDocumentClient } from "../supabase/documentClient.js";
import { waitUntil } from "@vercel/functions";
import { fetchPublicContentDocuments, readPublicContentRevision } from "../supabase/shadowStore.js";
import { clearSupabaseAssetManifestCache, enrichSupabaseContentAssets } from "../supabase/assets.js";
import policyContent from "../../lib/policyContent";
import { UPGRADE_LINK_SLUG_PATTERN } from "../../lib/globalCmsContract.js";

const { applyPublicPolicyOverrides } = policyContent;

const SUPABASE_CONTENT_CACHE_TTL_MS = 60 * 1000;
const SUPABASE_CONTENT_STALE_TTL_MS = 10 * 60 * 1000;
const supabaseContentCache = new Map();
const supabaseContentReads = new Map();

export const PUBLIC_CONTENT_CACHE_TAG = "public-content";
export const PUBLIC_CONTENT_READ_DEADLINE_MS = 5 * 1000;
const PUBLIC_CONTENT_REVISION_CHECK_BUDGET_MS = 2 * 1000;
export const PUBLIC_CONTENT_SECOND_PURGE_DELAY_MS = PUBLIC_CONTENT_REVISION_CHECK_BUDGET_MS + 3 * 1000;
export const PUBLIC_CONTENT_FIRST_PURGE_WAIT_MS = 2 * 1000;

const UPGRADE_LINK_INDEX_RESOURCE = "upgrade-link-index";
const CONTENT_QUERIES = Object.freeze({
  ...PUBLIC_CONTENT_QUERIES,
  [UPGRADE_LINK_INDEX_RESOURCE]: `*[_type == "upgradeLink"][0...1000]{"slug": slug.current}`,
});

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
  [UPGRADE_LINK_INDEX_RESOURCE]: ["upgradeLink"],
});
const ASSET_DEREFERENCE_RESOURCES = new Set(["tools"]);

const createPublicContentClient = ({ resource, revisions }) => {
  const assetDocumentTypes = ASSET_DEREFERENCE_RESOURCES.has(resource)
    ? ["sanity.imageAsset", "sanity.fileAsset"]
    : [];
  return createSupabaseDocumentClient({
    documentTypes: [
      ...(DOCUMENT_TYPES_BY_RESOURCE[resource] || []),
      ...assetDocumentTypes,
    ],
    readDocuments: async (scope) => {
      const { revision, documents } = await fetchPublicContentDocuments(scope);
      revisions.add(revision);
      return documents;
    },
  });
};

const PUBLIC_CONTENT_READ_ATTEMPTS = 3;

const readPublicContent = async ({ resource, query, params }) => {
  for (let attempt = 1; attempt <= PUBLIC_CONTENT_READ_ATTEMPTS; attempt += 1) {
    const revisions = new Set();
    const data = await createPublicContentClient({ resource, revisions }).fetch(query, params);
    if (revisions.size <= 1) {
      return { data: await enrichSupabaseContentAssets({ data }), revision: revisions.size ? [...revisions][0] : null };
    }
  }
  throw Object.assign(new Error("Public content kept changing while it was read."), { status: 503, code: "PUBLIC_CONTENT_REVISION_MOVED" });
};

const parseTitles = (searchParams) => {
  const raw = searchParams.getAll("title").flatMap((value) => value.split(","));
  const titles = [...new Set(raw.map((value) => value.trim()).filter(Boolean))].sort();
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

const timely = (check) => Date.now() - check.startedAt <= PUBLIC_CONTENT_REVISION_CHECK_BUDGET_MS;

let revisionCheck = null;
const checkRevision = () => {
  if (revisionCheck) return revisionCheck;
  const startedAt = Date.now();
  const pending = readPublicContentRevision().then((revision) => ({ revision, startedAt }));
  revisionCheck = pending;
  pending
    .finally(() => {
      if (revisionCheck === pending) revisionCheck = null;
    })
    .catch(() => {});
  return pending;
};

const storeTimeout = () =>
  Object.assign(new Error("Public content store did not answer in time."), { status: 503, code: "PUBLIC_CONTENT_STORE_TIMEOUT" });

const withinDeadline = (pending) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(storeTimeout()), PUBLIC_CONTENT_READ_DEADLINE_MS);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const lastGoodCopy = (key) => {
  const entry = key ? supabaseContentCache.get(key) : null;
  if (!entry || Date.now() - entry.confirmedAt > SUPABASE_CONTENT_STALE_TTL_MS) return null;
  return { data: entry.data, revision: entry.revision, cacheable: false };
};

const startStoreRead = ({ resource, query, params, key, revision }) => {
  const readKey = `${revision}|${resource}|${JSON.stringify(params)}`;
  const joined = supabaseContentReads.get(readKey);
  if (joined) return joined;

  const read = { deadlineAt: Date.now() + PUBLIC_CONTENT_READ_DEADLINE_MS };
  read.result = readPublicContent({ resource, query, params })
    .then(async (entry) => {
      const check = await withinDeadline(checkRevision()).catch(() => null);
      const settled = check !== null && check.revision === entry.revision;
      if (settled && key) {
        supabaseContentCache.set(key, { data: entry.data, revision: entry.revision, readAt: Date.now(), confirmedAt: Date.now() });
      }
      return { ...entry, cacheable: settled && timely(check) };
    })
    .finally(() => {
      if (supabaseContentReads.get(readKey) === read) supabaseContentReads.delete(readKey);
    });
  supabaseContentReads.set(readKey, read);
  waitUntil(read.result.catch(() => {}));
  return read;
};

const awaitStoreRead = (read, key) =>
  new Promise((resolve, reject) => {
    let answered = false;
    const answer = (settle, value) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      settle(value);
    };
    const timer = setTimeout(() => {
      const copy = lastGoodCopy(key);
      if (copy) answer(resolve, copy);
      else answer(reject, storeTimeout());
    }, Math.max(0, read.deadlineAt - Date.now()));
    read.result.then(
      (entry) => answer(resolve, entry),
      (error) => {
        const copy = lastGoodCopy(key);
        if (copy) answer(resolve, copy);
        else answer(reject, error);
      },
    );
  });

const loadAt = async ({ resource, query, params, key, check }) => {
  const entry = key ? supabaseContentCache.get(key) : null;
  if (entry && entry.revision === check.revision && Date.now() - entry.readAt <= SUPABASE_CONTENT_CACHE_TTL_MS) {
    entry.confirmedAt = Date.now();
    return { data: entry.data, revision: entry.revision, cacheable: timely(check) };
  }
  return awaitStoreRead(startStoreRead({ resource, query, params, key, revision: check.revision }), key);
};

const PACKAGES_INDEX = { resource: "packages-list", key: "packages-list", limit: 500 };
const UPGRADE_LINK_INDEX = { resource: UPGRADE_LINK_INDEX_RESOURCE, key: UPGRADE_LINK_INDEX_RESOURCE, limit: 1000 };

const indexFor = (resource) => (resource === "package" ? PACKAGES_INDEX : resource === "upgrade-link" ? UPGRADE_LINK_INDEX : null);

const knownValues = (resource, rows) =>
  new Set(
    (Array.isArray(rows) ? rows : []).map((row) =>
      resource === "package" ? row?.title : String(row?.slug || "").trim().toLowerCase(),
    ),
  );

const narrowToKnown = (resource, params, known) => {
  if (resource === "package") {
    const titles = params.titles.filter((title) => known.has(title));
    return titles.length ? { titles } : null;
  }
  return known.has(params.slug) ? params : null;
};

const memoryKey = (resource, params) =>
  resource === "package"
    ? `package:${params.titles.join(",")}`
    : resource === "upgrade-link"
      ? `upgrade-link:${params.slug}`
      : resource;

const readIndex = async (resource, check) => {
  const index = indexFor(resource);
  if (!index) return null;
  const entry = await loadAt({ resource: index.resource, query: CONTENT_QUERIES[index.resource], params: {}, key: index.key, check });
  if (entry.revision !== check.revision || !Array.isArray(entry.data) || entry.data.length >= index.limit) return null;
  return knownValues(resource, entry.data);
};

const fallbackFor = (resource, params, error) => {
  const index = indexFor(resource);
  const known = index ? supabaseContentCache.get(index.key) : null;
  const narrowed = !index ? params : known ? narrowToKnown(resource, params, knownValues(resource, known.data)) : null;
  const copy = narrowed ? lastGoodCopy(memoryKey(resource, narrowed)) : null;
  if (copy) return copy;
  throw error;
};

const loadSupabasePublicContent = async ({ resource, query, params }) => {
  let check;
  try {
    check = await withinDeadline(checkRevision());
  } catch (error) {
    return fallbackFor(resource, params, error);
  }
  if (!indexFor(resource)) return loadAt({ resource, query, params, key: resource, check });
  let known;
  try {
    known = await readIndex(resource, check);
  } catch (error) {
    return fallbackFor(resource, params, error);
  }
  if (!known) return loadAt({ resource, query, params, key: null, check });
  const narrowed = narrowToKnown(resource, params, known);
  if (!narrowed) return { data: null, revision: check.revision, cacheable: timely(check) };
  return loadAt({ resource, query, params: narrowed, key: memoryKey(resource, narrowed), check });
};

export const clearSupabasePublicContentCache = () => {
  supabaseContentReads.clear();
  supabaseContentCache.clear();
  clearSupabaseAssetManifestCache();
};

export const fetchPublicContentEntry = async ({ resource, searchParams }) => {
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
  const { data, revision, cacheable } = await loadSupabasePublicContent({ resource, query, params });
  return {
    data: applyPublicPolicyOverrides(resource, resource === "tools" ? stableToolDownloadLinks(data) : data),
    revision,
    cacheable,
  };
};

export const fetchPublicContent = async (options) => (await fetchPublicContentEntry(options)).data;
