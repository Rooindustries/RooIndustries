import {
  createDocumentReadClient,
  createDocumentWriteClient,
  createOptionalDocumentWriteClient,
} from "../../data/documentClient.js";

const DEFAULT_API_VERSION = "2023-10-01";

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
  dataset: requireAnyEnvValue(
    ["SANITY_PRIVATE_DATASET", "SANITY_DATASET"],
    "Missing required environment variable: SANITY_PRIVATE_DATASET"
  ),
  apiVersion: readFirstEnv(["SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION"]) || DEFAULT_API_VERSION,
});

export const createRefReadClient = ({ perspective = "published" } = {}) => {
  return createDocumentReadClient({ perspective });
};

export const createRefWriteClient = ({ backendOverride = "" } = {}) =>
  createDocumentWriteClient({ backendOverride });

export const createOptionalRefWriteClient = () =>
  createOptionalDocumentWriteClient();
