import { createClient } from "@sanity/client";
import { createImageUrlBuilder } from "@sanity/image-url";

const isBrowser = typeof window !== "undefined";
const browserApiHost = isBrowser ? `${window.location.origin}/api/sanity` : null;

export const client = createClient({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || "9g42k3ur",
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || "production",
  apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION || "2023-10-01",
  useProjectHostname: false,
  apiHost: browserApiHost || process.env.SANITY_API_ORIGIN || "https://api.sanity.io",
  useCdn: true,
});

const builder = createImageUrlBuilder(client);

export const urlFor = (source) => builder.image(source);
