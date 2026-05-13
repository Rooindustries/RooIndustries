import { createClient } from "@sanity/client";
import { createImageUrlBuilder } from "@sanity/image-url";
import marketConfig from "./lib/market";

const isBrowser = typeof window !== "undefined";
const browserApiHost = isBrowser ? `${window.location.origin}/api/sanity` : null;
const { resolveMarketSanityDataset } = marketConfig;
const legacyDataset =
  process.env.NEXT_PUBLIC_SANITY_DATASET ||
  process.env.SANITY_DATASET ||
  resolveMarketSanityDataset();
const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || "9g42k3ur";
const apiVersion = process.env.NEXT_PUBLIC_SANITY_API_VERSION || "2023-10-01";

export const client = createClient({
  projectId,
  dataset: legacyDataset,
  apiVersion,
  useProjectHostname: false,
  apiHost: browserApiHost || process.env.SANITY_API_ORIGIN || "https://api.sanity.io",
  useCdn: true,
});

export const publicClient = client;

const imageClient = createClient({
  projectId,
  dataset: legacyDataset,
  apiVersion,
  useCdn: true,
});

const builder = createImageUrlBuilder(imageClient);

export const urlFor = (source) => builder.image(source);
export const publicUrlFor = urlFor;
