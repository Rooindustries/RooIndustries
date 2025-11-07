import sanityClient from "@sanity/client";

export const client = sanityClient({
  projectId: "9g42k3ur",
  dataset: "production",
  apiVersion: "2023-10-01",
  useCdn: false,
  token: process.env.REACT_APP_SANITY_WRITE_TOKEN,
});
