import { createClient } from "@sanity/client";
import {
  PUBLIC_CONTENT_QUERIES,
  PUBLIC_CONTENT_RESOURCES,
} from "../../lib/publicContentQueries";

const DEFAULT_API_VERSION = "2026-06-09";

const readEnv = (...keys) =>
  keys
    .map((key) => String(process.env[key] || "").trim())
    .find(Boolean) || "";

const createPublicContentClient = () => {
  const projectId = readEnv("SANITY_PROJECT_ID", "NEXT_PUBLIC_SANITY_PROJECT_ID");
  const dataset = readEnv("SANITY_DATASET", "NEXT_PUBLIC_SANITY_DATASET") || "production";
  const token = readEnv(
    "SANITY_READ_TOKEN",
    "SANITY_PRIVATE_READ_TOKEN",
    "SANITY_WRITE_TOKEN"
  );
  if (!projectId || !dataset) {
    throw new Error("Sanity public content access is not configured.");
  }
  return createClient({
    projectId,
    dataset,
    apiVersion: readEnv("SANITY_API_VERSION") || DEFAULT_API_VERSION,
    ...(token ? { token } : {}),
    useCdn: true,
    perspective: "published",
  });
};

const parseTitles = (searchParams) => {
  const raw = searchParams.getAll("title").flatMap((value) => value.split(","));
  const titles = [...new Set(raw.map((value) => value.trim()).filter(Boolean))];
  if (titles.length < 1 || titles.length > 8 || titles.some((value) => value.length > 100)) {
    const error = new Error("A valid package title is required.");
    error.status = 400;
    throw error;
  }
  return titles;
};

const parseSlug = (searchParams) => {
  const slug = String(searchParams.get("slug") || "").trim().toLowerCase();
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
        : []
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

export const fetchPublicContent = async ({ resource, searchParams }) => {
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
  return createPublicContentClient().fetch(query, params);
};
