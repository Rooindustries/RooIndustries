import { stableCmsJson } from "../globalCmsContract.js";
import { fieldUsageContext, isUnusedField } from "./fieldUsage.js";

export const CMS_SYSTEM_FIELDS = new Set(["_id", "_type", "_rev", "_createdAt", "_updatedAt", "_createdBy", "_originalId", "_system"]);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

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
export const preserveContentDocument = (input, current, fields, keyFor, path = "$", root = true, context = {}) => {
  if (!plain(input)) return input;
  const output = root ? Object.fromEntries(Object.entries(input).filter(([key]) => !CMS_SYSTEM_FIELDS.has(key))) : { ...input };
  const fieldContext = fieldUsageContext(fields, input, context);
  const known = new Set(fields.map(field => field.name));
  for (const [key, value] of Object.entries(current || {})) if (!known.has(key) && !(root && CMS_SYSTEM_FIELDS.has(key)) && !key.startsWith("_supabase") && output[key] === undefined) output[key] = value;
  for (const field of fields) {
    if (field.readOnly || isUnusedField(field, input, fieldContext)) {
      if (field.preserveStoredValue && current && Object.hasOwn(current, field.name)) output[field.name] = current[field.name];
      else if (!field.preserveStoredValue) delete output[field.name];
      continue;
    }
    const value = output[field.name];
    const prior = current?.[field.name];
    if (field.type === "object" && plain(value)) output[field.name] = preserveContentDocument(value, prior, field.fields || [], keyFor, `${path}.${field.name}`, false, fieldContext);
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
      const next = candidate?.type === "object" ? preserveContentDocument(item, previous, candidate.fields || [], keyFor, `${path}.${field.name}[${index}]`, false, fieldContext) : candidate?.type === "block" ? preserveBlock(item, previous) : mergeStoredExtras(item, previous, new Set(["_ref", "_weak"]));
      if (!next._key && keyFor && stableCmsJson(item) !== stableCmsJson(previous)) next._key = keyFor(`${path}.${field.name}[${index}]`, item);
      return next;
    });
  }
  return output;
};

const itemTypeFor = (field, item) => field.of?.find(type => type.name === item?._type || type.type === item?._type) || field.of?.[0];

export const rowRemovalProtected = (row, fields, context = {}) => {
  if (!plain(row) || !fields?.length) return false;
  const fieldContext = fieldUsageContext(fields, row, context);
  const contentFields = fields.filter(field => !field.overrideKey);
  if (contentFields.length && contentFields.every(field => field.preserveStoredValue && (field.readOnly || isUnusedField(field, row, fieldContext)))) return true;
  return fields.some(field => {
    const value = row[field.name];
    if (field.type === "object") return rowRemovalProtected(value, field.fields, fieldContext);
    return field.type === "array" && Array.isArray(value) && value.some(item => rowRemovalProtected(item, itemTypeFor(field, item)?.fields, fieldContext));
  });
};

export const findStoredRow = (rows, item, fields = []) => {
  if (!Array.isArray(rows) || !plain(item)) return undefined;
  if (item._key) return rows.find(row => row?._key === item._key);
  const selectors = new Set(fields.filter(field => field.overrideKey).map(field => field.name));
  const content = row => stableCmsJson(Object.fromEntries(Object.entries(row || {}).filter(([key]) => key !== "_key" && !selectors.has(key))));
  const expected = content(item);
  return rows.find(row => content(row) === expected);
};

export const storedFieldAtPath = (baseline, submitted, path) => {
  let stored = baseline, current = submitted, context = {};
  for (const segment of path) {
    if (stored && Object.hasOwn(stored, "variant")) context = { ...context, variant: stored.variant };
    if (typeof segment === "number") {
      const key = current?.[segment]?._key;
      stored = key ? stored?.find?.(item => item?._key === key) : stored?.[segment];
    } else stored = stored?.[segment];
    current = current?.[segment];
  }
  return { value: stored, context };
};

export const removedProtectedRows = (baseline, submitted, fields, context = {}, path = "$", result = []) => {
  if (!plain(baseline)) return result;
  const fieldContext = fieldUsageContext(fields, baseline, context);
  for (const field of fields) {
    const stored = baseline[field.name], next = submitted?.[field.name];
    if (field.type === "object") removedProtectedRows(stored, next, field.fields || [], fieldContext, `${path}.${field.name}`, result);
    if (field.type !== "array" || !Array.isArray(stored)) continue;
    stored.forEach((item, index) => {
      const definition = itemTypeFor(field, item);
      if (!definition?.fields) return;
      const replacement = item?._key ? next?.find?.(row => row?._key === item._key) : findStoredRow(next, item, definition.fields) || (next?.length === stored.length ? next[index] : undefined);
      if (!replacement && rowRemovalProtected(item, definition.fields, fieldContext)) result.push(`${path}.${field.name}[${index}]`);
      else removedProtectedRows(item, replacement, definition.fields, fieldContext, `${path}.${field.name}[${index}]`, result);
    });
  }
  return result;
};
