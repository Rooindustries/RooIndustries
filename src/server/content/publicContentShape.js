import { CONTENT_TYPES } from "../../lib/cms/contentSchema.js";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const listResources = new Set(["packages-list", "tools", "benchmarks", "reviews-gallery"]);
const textTypes = new Set(["string", "text", "url", "email", "date", "datetime"]);
const schemas = new Map(CONTENT_TYPES.map(schema => [schema.name, schema]));

const matchesField = (field, value) => {
  if (value == null) return true;
  if (textTypes.has(field.type)) return typeof value === "string" || field.name === "price" && typeof value === "number" && Number.isFinite(value);
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "object") return object(value) && matchesFields(field.fields || [], value);
  if (field.type === "array") return Array.isArray(value) && value.every(item => item != null && (field.of || []).some(shape => matchesField(shape, item)));
  if (field.type === "block") {
    return object(value) && value._type === "block" && Array.isArray(value.children) && value.children.every(span => object(span) && span._type === "span" && typeof span.text === "string" && (span.marks == null || Array.isArray(span.marks) && span.marks.every(mark => typeof mark === "string"))) &&
      (value.markDefs == null || Array.isArray(value.markDefs) && value.markDefs.every(mark => object(mark) && (mark.href == null || typeof mark.href === "string")));
  }
  return object(value);
};
const matchesFields = (fields, value) => fields.every(field => matchesField(field, value[field.name]));

export const assertPublicContentShape = (resource, value, type) => {
  if (value == null) return;
  const fields = schemas.get(type)?.fields || [];
  let valid;
  if (resource === "faq-questions") {
    valid = matchesField(fields.find(field => field.name === "questions"), value);
  } else if (listResources.has(resource)) {
    valid = Array.isArray(value) && value.every(row => object(row) && matchesFields(fields, row));
  } else {
    valid = object(value) && matchesFields(fields, value);
  }
  if (valid && resource === "tools") {
    valid = value.every(tool => ["iconUrl", "fileUrl"].every(key => tool[key] == null || typeof tool[key] === "string"));
  }
  if (valid && ["privacy-policy", "terms"].includes(resource)) {
    valid = typeof value.title === "string" && Boolean(value.title.trim()) && Array.isArray(value.sections) &&
      value.sections.some(section => section.content?.some(block => block.children?.some(span => span.text?.trim())));
  }
  if (!valid) throw Object.assign(new Error("Published content has an invalid shape."), { code: "PUBLIC_CONTENT_INVALID", status: 503 });
};
