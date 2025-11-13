import { createClient } from "@sanity/client";
import imageUrlBuilder from "@sanity/image-url";

export const client = createClient({
  projectId: "9g42k3ur",
  dataset: "production",
  apiVersion: "2023-10-01",
  useCdn: true,
  token: process.env.REACT_APP_SANITY_WRITE_TOKEN,
});

const builder = imageUrlBuilder(client);
export const urlFor = (source) => builder.image(source);
