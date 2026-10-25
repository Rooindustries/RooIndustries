import { evaluate, parse } from "groq-js";
import { PUBLIC_CONTENT_QUERIES } from "../../lib/publicContentQueries.js";
import { assertPublicContentShape } from "./publicContentShape.js";
import { enrichSupabaseContentAssets } from "../supabase/assets.js";
import { cmsError } from "../cms/errors.js";
import { createHash } from "node:crypto";

const bucket = "public-content-state";
const storedPublications = new Map();
const sha256 = value => createHash("sha256").update(value).digest("hex");
const types = {
  reviews: "proReviewsCarousel", about: "about", services: "services", "packages-list": "package",
  "packages-settings": "packagesSettings", "how-it-works": "howItWorks", "supported-games": "supportedGames",
  "faq-settings": "faqSettings", "faq-questions": "faqSection", hero: "hero", team: "meetTheTeam",
  contact: "contact", tools: "tool", benchmarks: "benchmark", "discord-banner": "discordBanner",
  terms: "terms", "privacy-policy": "privacyPolicy", "reviews-gallery": "review", "referral-box": "referralBox",
};
export const isPublicContentType = type => Object.values(types).includes(type);
export const contentGeneration = value => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) throw new Error("Public content generation is invalid.");
  const generation = BigInt(value);
  if (generation > 9223372036854775807n) throw new Error("Public content generation exceeds its database range.");
  return generation;
};
const requireData = result => {
  if (result.error) throw cmsError("The public content publication could not be confirmed.", 503, "CMS_PUBLICATION_UNAVAILABLE");
  return result.data;
};
const validate = (value, generation) => {
  if (value?.version !== 1 || contentGeneration(value.generation) !== contentGeneration(generation) ||
      !value.resources || typeof value.resources !== "object" || Array.isArray(value.resources)) throw new Error("Public content publication is invalid.");
  for (const [resource, data] of Object.entries(value.resources)) {
    if (!Object.hasOwn(types, resource)) throw new Error("Public content publication has an invalid resource.");
    assertPublicContentShape(resource, data, types[resource]);
  }
  return value;
};
export const readPublicContentPublication = async client => {
  const files = requireData(await client.storage.from(bucket).list("heads", { limit: 1, sortBy: { column: "name", order: "desc" } }));
  if (!Array.isArray(files)) throw new Error("Public content publication listing is invalid.");
  if (!files.length) return null;
  const name = files[0]?.name;
  if (typeof name !== "string" || !/^[0-9]{20}-[a-f0-9]{64}\.json$/.test(name)) throw new Error("Public content publication identity is invalid.");
  const generation = BigInt(name.slice(0, 20)).toString();
  contentGeneration(generation);
  const digest = name.slice(21, 85);
  const bindingBody = requireData(await client.storage.from(bucket).download(`heads/${name}`));
  if (bindingBody.size > 1024) throw new Error("Public content publication binding exceeds its size limit.");
  const binding = JSON.parse(await bindingBody.text());
  if (binding?.generation !== generation || binding.sha256 !== digest || binding.path !== `snapshots/${name}`) throw new Error("Public content publication binding is invalid.");
  const key = client.storage.from(bucket).getPublicUrl(binding.path).data.publicUrl;
  if (storedPublications.has(key)) return storedPublications.get(key);
  const body = requireData(await client.storage.from(bucket).download(binding.path));
  if (body.size > 8388608) throw new Error("Public content publication exceeds its size limit.");
  const serialized = await body.text();
  if (sha256(serialized) !== digest) throw new Error("Public content publication hash is invalid.");
  const publication = validate(JSON.parse(serialized), generation);
  if (storedPublications.size >= 8) storedPublications.delete(storedPublications.keys().next().value);
  storedPublications.set(key, publication);
  return publication;
};
const uploadImmutable = async (client, name, serialized) => {
  if (Buffer.byteLength(serialized) > 8388608) throw new Error("Public content publication exceeds its size limit.");
  const uploaded = await client.storage.from(bucket).upload(name, Buffer.from(serialized), { contentType: "application/json", cacheControl: "31536000", upsert: false });
  if (uploaded.error) {
    if (Number(uploaded.error.statusCode) !== 409) requireData(uploaded);
    const existing = requireData(await client.storage.from(bucket).download(name));
    if (await existing.text() !== serialized) throw cmsError("The public content publication does not match its source.", 503, "CMS_PUBLICATION_INVALID");
  }
  const verified = requireData(await client.storage.from(bucket).download(name));
  if (sha256(await verified.text()) !== sha256(serialized)) throw cmsError("The public content publication hash could not be confirmed.", 503, "CMS_PUBLICATION_INVALID");
};
export const persistPublicContentPublication = async (client, requiredType) => {
  const captured = requireData(await client.rpc("roo_capture_public_content_publication"));
  contentGeneration(captured?.generation);
  if (!Array.isArray(captured.documents) || !Array.isArray(captured.assets) || captured.documents.some(row => !row || typeof row._id !== "string" || typeof row._type !== "string")) throw new Error("Public content publication source is invalid.");
  const projectionClient = {
    storage: client.storage,
    rpc: async (name, params) => {
      if (name !== "roo_asset_manifest_for_refs") throw new Error("Unexpected publication asset lookup.");
      return { data: captured.assets.filter(asset => params.p_asset_ids.includes(asset.legacy_sanity_asset_id) || params.p_source_urls.includes(asset.source_url)), error: null };
    },
  };
  const resources = {};
  for (const [resource, type] of Object.entries(types)) {
    const projected = await (await evaluate(parse(PUBLIC_CONTENT_QUERIES[resource]), { dataset: captured.documents, params: {} })).get();
    if (resource === "tools" && Array.isArray(projected)) {
      for (const tool of projected) for (const field of ["downloadUrl", "officialSite"]) if (typeof tool?.[field] === "string") tool[field] = tool[field].trim();
    }
    try { assertPublicContentShape(resource, projected, type); }
    catch (error) { if (error.code === "PUBLIC_CONTENT_INVALID" && type !== requiredType) continue; throw error; }
    resources[resource] = await enrichSupabaseContentAssets({ data: projected, client: projectionClient });
  }
  const publication = { version: 1, generation: captured.generation, resources };
  const serialized = JSON.stringify(publication);
  const digest = sha256(serialized);
  const name = `${captured.generation.padStart(20, "0")}-${digest}.json`;
  const objectPath = `snapshots/${name}`;
  await uploadImmutable(client, objectPath, serialized);
  const binding = requireData(await client.rpc("roo_bind_public_content_publication", { p_generation: captured.generation, p_sha256: digest, p_object_path: objectPath }));
  contentGeneration(binding?.generation);
  if (typeof binding.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(binding.sha256) ||
      binding.path !== `snapshots/${binding.generation.padStart(20, "0")}-${binding.sha256}.json`) throw new Error("Public content database binding is invalid.");
  const boundBytes = requireData(await client.storage.from(bucket).download(binding.path));
  if (sha256(await boundBytes.text()) !== binding.sha256) throw new Error("Public content database binding hash is invalid.");
  await uploadImmutable(client, `heads/${binding.path.slice("snapshots/".length)}`, JSON.stringify(binding));
  const current = await readPublicContentPublication(client);
  if (!current || contentGeneration(current.generation) < contentGeneration(captured.generation)) throw cmsError("The public content publication has not become readable.", 503, "CMS_PUBLICATION_UNAVAILABLE");
  return current;
};
