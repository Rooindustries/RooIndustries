import crypto from "node:crypto";
import { validateContentDocument, createContentDefaults } from "../../lib/cms/contentSchema.js";
import { stableCmsJson } from "../../lib/globalCmsContract.js";
import { clearSupabasePublicContentCache } from "../content/publicContent.js";
import { contentType, documentId, loadDocument } from "./documents.js";
import { cmsError, rpcData, validationError } from "./errors.js";
import { assertGlobalCmsWritesAllowed } from "./writeControl.js";

const counters = new Set(["timesUsed", "activeReservations", "redemptionCount", "autoDeactivatedByRedemptionId", "autoDeactivatedAt"]);
const system = new Set(["_id", "_type", "_rev", "_createdAt", "_updatedAt", "_createdBy", "_originalId", "_system"]);
const hash = value => crypto.createHash("sha256").update(stableCmsJson(value)).digest("hex");
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const createIntentDocumentId = intent => {
  const bytes = crypto.createHash("sha256").update(`cms-create:${intent.toLowerCase()}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const refuseEnrichment = (value, path = "$", depth = 0) => {
  if (depth > 20) throw validationError(path, "Content exceeds the structural limit.");
  if (Array.isArray(value)) { if (value.length > 1000) throw validationError(path, "At most 1000 items are supported."); value.forEach((item, i) => refuseEnrichment(item, `${path}[${i}]`, depth + 1)); }
  else if (plain(value)) for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("_supabase")) throw validationError(`${path}.${key}`, "Runtime asset enrichment cannot be published.");
    if (["__proto__", "constructor", "prototype"].includes(key)) throw validationError(`${path}.${key}`, "Reserved field.");
    refuseEnrichment(item, `${path}.${key}`, depth + 1);
  }
};
const mergeStoredExtras = (value, current, known) => {
  if (!plain(value)) return value;
  const output = { ...value };
  for (const [key, item] of Object.entries(current || {})) if (!known.has(key) && !key.startsWith("_supabase") && output[key] === undefined) output[key] = item;
  return output;
};
const preserveBlock = (value, current) => {
  const block = mergeStoredExtras(value, current, new Set(["style", "listItem", "level", "children", "markDefs"]));
  for (const [name, known] of [["children", ["text", "marks"]], ["markDefs", ["href"]]]) if (Array.isArray(block[name])) block[name] = block[name].map(item => mergeStoredExtras(item, current?.[name]?.find(old => old?._key === item?._key), new Set(known)));
  return block;
};
const preservedDocument = (input, current, fields, seed, path = "$", root = true) => {
  if (!plain(input)) return input;
  const output = { ...input };
  const known = new Set(fields.map(field => field.name));
  for (const [key, value] of Object.entries(current || {})) if (!known.has(key) && !(root && system.has(key)) && !key.startsWith("_supabase") && output[key] === undefined) output[key] = value;
  for (const field of fields) {
    if (field.readOnly) { delete output[field.name]; continue; }
    const value = output[field.name];
    const prior = current?.[field.name];
    if (field.type === "object" && plain(value)) output[field.name] = preservedDocument(value, prior, field.fields || [], seed, `${path}.${field.name}`, false);
    if (["image", "file", "reference", "slug"].includes(field.type) && plain(value)) {
      const known = new Set(field.type === "reference" ? ["_ref", "_weak"] : field.type === "slug" ? ["current"] : ["asset", "crop", "hotspot"]);
      output[field.name] = mergeStoredExtras(value, prior, known);
      if (value.asset) output[field.name].asset = mergeStoredExtras(value.asset, prior?.asset, new Set(["_ref", "_weak"]));
      if (value.crop) output[field.name].crop = mergeStoredExtras(value.crop, prior?.crop, new Set(["top", "bottom", "left", "right"]));
      if (value.hotspot) output[field.name].hotspot = mergeStoredExtras(value.hotspot, prior?.hotspot, new Set(["x", "y", "width", "height"]));
    }
    if (field.type === "array" && Array.isArray(value)) output[field.name] = value.map((item, index) => {
      if (!plain(item)) return item;
      const previous = item._key ? prior?.find?.(entry => entry?._key === item._key) : prior?.[index];
      const candidate = field.of?.find(type => type.name === item._type || type.type === item._type) || field.of?.[0];
      const next = candidate?.type === "object" ? preservedDocument(item, previous, candidate.fields || [], seed, `${path}.${field.name}[${index}]`, false) : candidate?.type === "block" ? preserveBlock(item, previous) : mergeStoredExtras(item, previous, new Set(["_ref", "_weak"]));
      if (!next._key && stableCmsJson(item) !== stableCmsJson(previous)) next._key = hash({ seed, path: `${path}.${field.name}[${index}]`, item }).slice(0, 20);
      return next;
    });
  }
  return output;
};
const committed = (result, id) => {
  const record = result?.results?.find?.(entry => entry?._id === id || entry?.id === id) || result?.results?.[0];
  const revision = record?._rev || record?.document?._rev;
  if (!revision || typeof revision !== "string") throw cmsError("The committed receipt is missing its revision. Retry the same request.", 503, "CMS_RECEIPT_INVALID");
  clearSupabasePublicContentCache();
  return { committed: true, replayed: result.replayed === true, documentId: id, revision };
};
export const executeGlobalCmsCommand = async ({ body, supabaseClient, env = process.env, actor = "admin:key" } = {}) => {
  assertGlobalCmsWritesAllowed(env);
  if (!plain(body)) throw validationError("$", "A JSON content command is required.");
  const allowed = new Set(["operation", "type", "documentId", "document", "expectedRevision", "createIntentId"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw validationError(`$.${key}`, "Unsupported command field.");
  if (!["create", "replace", "delete"].includes(body.operation)) throw validationError("$.operation", "Choose create, replace or delete.");
  const schema = contentType(body.type);
  const creating = body.operation === "create";
  if (creating && !uuid(body.createIntentId)) throw validationError("$.createIntentId", "A stable create-intent UUID is required.");
  if (creating && body.expectedRevision !== undefined) throw validationError("$.expectedRevision", "Create cannot supply a loaded revision.");
  if (!creating && body.createIntentId !== undefined) throw validationError("$.createIntentId", "Create intent applies only to create.");
  const id = creating ? schema.fixedId || createIntentDocumentId(body.createIntentId) : documentId(body.documentId);
  if (creating && body.documentId !== undefined && body.documentId !== id) throw validationError("$.documentId", "The server derives the new identity from the create intent.");
  if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== "string" || body.expectedRevision.length > 128)) throw validationError("$.expectedRevision", "A loaded revision is required.");
  let document = null;
  if (body.operation !== "delete") {
    if (!plain(body.document)) throw validationError("$.document", "A document is required.");
    refuseEnrichment(body.document);
    if (body.document._type !== undefined && body.document._type !== body.type) throw validationError("$._type", "Document type does not match.");
    if (body.document._id !== undefined && body.document._id !== id) throw validationError("$._id", "Document identity does not match.");
    document = Object.fromEntries(Object.entries(body.document).filter(([key]) => !system.has(key) && !(body.type === "coupon" && counters.has(key))));
    if (creating) document = { ...createContentDefaults(body.type), ...document };
  } else if (body.document !== undefined) throw validationError("$.document", "Delete accepts no document.");
  const material = { actor, operation: body.operation, type: body.type, documentId: id, createIntentId: creating ? body.createIntentId.toLowerCase() : null, expectedRevision: body.expectedRevision || null, document };
  const requestHash = hash(material);
  const commandId = `cms:${requestHash}`;
  const lookup = { p_command_id: commandId, p_request_hash: requestHash, p_actor: actor };
  const receipt = rpcData(await supabaseClient.rpc("roo_cms_publish_command_result", lookup), "Receipt lookup");
  if (receipt?.replayed) return committed(receipt, id);
  const current = await loadDocument(supabaseClient, id);
  if (current && current._type !== body.type) throw cmsError("Document type conflicts with its stored identity.", 409, "CMS_TYPE_MISMATCH", { currentRevision: current._rev });
  if (document) {
    document = preservedDocument(document, current, schema.fields, requestHash);
    const validation = validateContentDocument(body.type, document, { current });
    if (!validation.ok) throw cmsError("Content validation failed.", 400, "CMS_VALIDATION_FAILED", validation.errors);
    document = { ...document, _id: id, _type: body.type };
  }
  const mutation = { operation: body.operation, id, ...(document ? { document } : {}), ...(!creating ? { expected_revision: body.expectedRevision || "" } : {}) };
  const result = rpcData(await supabaseClient.rpc("roo_apply_cms_publish_command", { ...lookup, p_mutations: [mutation], p_assets: [], p_asset_links: [] }), "Content publish");
  return committed(result, id);
};
