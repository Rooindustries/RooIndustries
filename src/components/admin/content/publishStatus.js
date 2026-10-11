const systemFields = new Set(["_id", "_type", "_rev", "_createdAt", "_updatedAt", "_createdBy", "_originalId", "_system"]);

const namedFields = names => names.map(name => ({ name }));
const assetFields = [
  { name: "asset", type: "reference" },
  { name: "crop", fields: namedFields(["top", "bottom", "left", "right"]) },
  { name: "hotspot", fields: namedFields(["x", "y", "width", "height"]) },
];
const structuredFields = {
  image: assetFields,
  file: assetFields,
  reference: namedFields(["_ref", "_weak"]),
  slug: namedFields(["current"]),
  block: [
    ...namedFields(["style", "listItem", "level"]),
    { name: "children", type: "array", of: [{ fields: namedFields(["text", "marks"]) }] },
    { name: "markDefs", type: "array", of: [{ fields: namedFields(["href"]) }] },
  ],
};

const collectRemovedPaths = (baseline, submitted, field, path = []) => {
  if (Array.isArray(submitted)) {
    return submitted.flatMap((item, index) => {
      const prior = item?._key ? baseline?.find?.(entry => entry?._key === item._key) : baseline?.[index];
      const itemType = field.of?.find(type => type.name === item?._type || type.type === item?._type) || field.of?.[0];
      return collectRemovedPaths(prior, item, itemType || {}, [...path, index]);
    });
  }
  if (!baseline || typeof baseline !== "object" || !submitted || typeof submitted !== "object") return [];
  return (field.fields || structuredFields[field.type] || []).flatMap(child => {
    if (child.readOnly || baseline[child.name] === undefined) return [];
    const nextPath = [...path, child.name];
    return submitted[child.name] === undefined
      ? [nextPath]
      : collectRemovedPaths(baseline[child.name], submitted[child.name], child, nextPath);
  });
};

export const removedContentPaths = (baseline, submitted, schema) =>
  collectRemovedPaths(baseline, submitted, schema);

const hasPath = (document, path) => {
  let current = document;
  for (const segment of path) {
    if (current == null || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
};

const sameContent = (expected, actual, fields = [], root = false) => {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, index) => {
      const itemType = fields.find(field => field.name === item?._type || field.type === item?._type) || fields[0];
      return sameContent(item, actual[index], itemType?.fields);
    });
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const ignored = new Set(fields.filter(field => field.readOnly).map(field => field.name));
    for (const key of Object.keys(expected)) {
      if (ignored.has(key) || (root && systemFields.has(key)) || (key === "_key" && expected[key] === undefined)) continue;
      const field = fields.find(field => field.name === key);
      if (!sameContent(expected[key], actual[key], field?.type === "array" ? field.of : field?.fields)) return false;
    }
    return true;
  }
  return expected === actual;
};

export const publishedContentMatches = (data, session, submitted, schema, removedPaths = session.documentId ? removedContentPaths(session.baseline, submitted, schema) : []) => {
  const document = data?.document;
  const id = session.documentId || data?.documentId;
  return typeof id === "string" && document?._id === id && document._type === session.type &&
    typeof data.revision === "string" && data.revision.length > 0 && data.revision === document._rev &&
    data.revision !== session.revision && sameContent(JSON.parse(JSON.stringify(submitted)), document, schema.fields, true) &&
    removedPaths.every(path => !hasPath(document, path));
};
