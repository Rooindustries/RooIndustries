const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

const bodyError = (message, status) =>
  Object.assign(new Error(message), { status });

const readBoundedBody = async (request, maxBytes) => {
  const declaredLength = Number(
    request?.headers?.get?.("content-length") || 0
  );
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw bodyError("Request body is too large.", 413);
  }

  const reader = request?.body?.getReader?.();
  if (!reader) {
    const raw = await request.text();
    const body = Buffer.from(raw, "utf8");
    if (body.byteLength > maxBytes) {
      throw bodyError("Request body is too large.", 413);
    }
    return body;
  }

  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw bodyError("Request body is too large.", 413);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, totalBytes);
};

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
  const mediaType = contentType.split(";", 1)[0].trim();
  if (mediaType !== "application/json") {
    throw bodyError("Content-Type must be application/json.", 415);
  }
  const raw = (await readBoundedBody(request, maxBytes)).toString("utf8");
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

export const readBoundedFormData = async (
  request,
  { maxBytes = 16 * 1024, maxFields = 64, allowFiles = false } = {}
) => {
  const rawContentType = String(
    request?.headers?.get?.("content-type") || ""
  );
  const contentType = rawContentType.toLowerCase();
  const mediaType = contentType.split(";", 1)[0].trim();
  if (
    mediaType !== "application/x-www-form-urlencoded" &&
    mediaType !== "multipart/form-data"
  ) {
    throw bodyError("Unsupported form Content-Type.", 415);
  }

  const body = await readBoundedBody(request, maxBytes);
  let form;
  try {
    const parsedRequest = new Request(request?.url || "http://localhost/", {
      method: "POST",
      headers: { "Content-Type": rawContentType },
      body,
    });
    form = await parsedRequest.formData();
  } catch {
    throw bodyError("Malformed form body.", 400);
  }

  const names = new Set();
  let fields = 0;
  for (const [name, value] of form.entries()) {
    fields += 1;
    if (fields > maxFields) {
      throw bodyError("Form body has too many fields.", 413);
    }
    if (unsafeKeys.has(name)) {
      throw bodyError("Form body contains an unsafe field.", 400);
    }
    if (names.has(name)) {
      throw bodyError("Duplicate form fields are not allowed.", 400);
    }
    names.add(name);
    if (!allowFiles && typeof value !== "string") {
      throw bodyError("File uploads are not allowed.", 400);
    }
  }
  return form;
};
