const systemFields = new Set(["_id", "_type", "_rev", "_createdAt", "_updatedAt", "_createdBy", "_originalId", "_system"]);

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
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      if (ignored.has(key) || (root && systemFields.has(key)) || (key === "_key" && expected[key] === undefined)) continue;
      const field = fields.find(field => field.name === key);
      if (!sameContent(expected[key], actual[key], field?.type === "array" ? field.of : field?.fields)) return false;
    }
    return true;
  }
  return expected === actual;
};

export const publishedContentMatches = (data, session, submitted, schema) => {
  const document = data?.document;
  const id = session.documentId || data?.documentId;
  return typeof id === "string" && document?._id === id && document._type === session.type &&
    typeof data.revision === "string" && data.revision.length > 0 && data.revision === document._rev &&
    data.revision !== session.revision && sameContent(JSON.parse(JSON.stringify(submitted)), document, schema.fields, true);
};
