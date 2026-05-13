import { createClient } from "@sanity/client";
import marketConfig from "../../../lib/market.js";

const DEFAULT_API_VERSION = "2023-10-01";
const { resolveMarketSanityDataset } = marketConfig;

const readFirstEnv = (keys = []) =>
  keys
    .map((key) => String(process.env[key] || "").trim())
    .find((value) => value.length > 0) || "";

export const requireEnvValue = (key, message = "") => {
  const value = String(process.env[key] || "").trim();
  if (!value) {
    throw new Error(message || `Missing required environment variable: ${key}`);
  }
  return value;
};

const requireAnyEnvValue = (keys = [], message = "") => {
  const value = readFirstEnv(keys);
  if (!value) {
    throw new Error(
      message ||
        `Missing required environment variable. Expected one of: ${keys.join(", ")}`
    );
  }
  return value;
};

export const resolveSanityEnv = () => ({
  projectId: requireAnyEnvValue(
    ["SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID"],
    "Missing required environment variable: SANITY_PRIVATE_PROJECT_ID"
  ),
  dataset:
    readFirstEnv(["SANITY_PRIVATE_DATASET", "SANITY_DATASET"]) ||
    resolveMarketSanityDataset(),
  apiVersion: readFirstEnv(["SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION"]) || DEFAULT_API_VERSION,
});

export const createRefReadClient = ({ perspective = "published" } = {}) => {
  const { projectId, dataset, apiVersion } = resolveSanityEnv();
  const token = readFirstEnv(["SANITY_PRIVATE_READ_TOKEN", "SANITY_READ_TOKEN"]);
  return createClient({
    projectId,
    dataset,
    apiVersion,
    useCdn: false,
    perspective,
    token: token || undefined,
  });
};

export const createRefWriteClient = () => {
  const { projectId, dataset, apiVersion } = resolveSanityEnv();
  const token = requireAnyEnvValue(
    ["SANITY_PRIVATE_WRITE_TOKEN", "SANITY_WRITE_TOKEN"],
    "SANITY_PRIVATE_WRITE_TOKEN is required for write operations."
  );

  return createClient({
    projectId,
    dataset,
    apiVersion,
    token,
    useCdn: false,
  });
};

export const createOptionalRefWriteClient = () => {
  const token = readFirstEnv(["SANITY_PRIVATE_WRITE_TOKEN", "SANITY_WRITE_TOKEN"]);
  if (!token) return null;
  const { projectId, dataset, apiVersion } = resolveSanityEnv();
  return createClient({
    projectId,
    dataset,
    apiVersion,
    token,
    useCdn: false,
  });
};
