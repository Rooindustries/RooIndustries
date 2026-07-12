const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

const hasDuplicateJsonKeys = (rawBody) => {
  const stack = [];
  for (let index = 0; index < rawBody.length; index += 1) {
    const char = rawBody[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < rawBody.length) {
        if (rawBody[index] === "\\") {
          index += 2;
          continue;
        }
        if (rawBody[index] === '"') break;
        index += 1;
      }
      let next = index + 1;
      while (/\s/.test(rawBody[next] || "")) next += 1;
      if (rawBody[next] === ":" && stack.at(-1)?.type === "object") {
        const key = JSON.parse(rawBody.slice(start, index + 1));
        if (stack.at(-1).keys.has(key)) return true;
        stack.at(-1).keys.add(key);
      }
      continue;
    }
    if (char === "{") stack.push({ type: "object", keys: new Set() });
    if (char === "[") stack.push({ type: "array" });
    if (char === "}" || char === "]") stack.pop();
  }
  return false;
};

const assertSafeShape = (root, { maxDepth, maxNodes }) => {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw Object.assign(new Error("JSON body must be an object."), {
      status: 400,
    });
  }
  const pending = [{ value: root, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop();
    nodes += 1;
    if (depth > maxDepth || nodes > maxNodes) {
      throw Object.assign(new Error("JSON body is too complex."), {
        status: 413,
      });
    }
    for (const [key, child] of Object.entries(value || {})) {
      if (unsafeKeys.has(key)) {
        throw Object.assign(new Error("JSON body contains an unsafe property."), {
          status: 400,
        });
      }
      if (child && typeof child === "object") {
        pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
};

export const readBoundedJson = async (
  request,
  { maxBytes = 16 * 1024, maxDepth = 10, maxNodes = 500 } = {}
) => {
  const contentType = String(
    request?.headers?.get?.("content-type") || ""
  ).toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json."), {
      status: 415,
    });
  }
  const declaredLength = Number(
    request?.headers?.get?.("content-length") || 0
  );
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    throw Object.assign(new Error("Malformed JSON body."), { status: 400 });
  }
  if (hasDuplicateJsonKeys(raw)) {
    throw Object.assign(new Error("Duplicate JSON properties are not allowed."), {
      status: 400,
    });
  }
  assertSafeShape(payload, { maxDepth, maxNodes });
  return payload;
};
