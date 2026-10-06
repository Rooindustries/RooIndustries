export const getIn = (value, path) =>
  path.reduce((current, segment) => (current == null ? undefined : current[segment]), value);

export const setIn = (value, path, next) => {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const copy = value.slice();
    copy[head] = setIn(value[head], rest, next);
    return copy;
  }
  const base = value && typeof value === "object" ? value : {};
  const child = setIn(base[head], rest, next);
  if (child === undefined) {
    const { [head]: _removed, ...remaining } = base;
    return remaining;
  }
  return { ...base, [head]: child };
};

export const pathLabel = (path) =>
  path.reduce((label, segment) => {
    if (typeof segment === "number") return `${label}[${segment}]`;
    return label ? `${label}.${segment}` : segment;
  }, "");

export const normalizeErrorPath = (path) => {
  if (Array.isArray(path)) return pathLabel(path);
  return String(path || "")
    .replace(/\[_key\s*==\s*["']([^"']+)["']\]/g, "[key:$1]")
    .replace(/\.(\d+)(?=\.|\[|$)/g, "[$1]")
    .replace(/^\$\.?/, "")
    .replace(/^\./, "");
};

export const indexErrors = (errors, document) => {
  const byPath = new Map();
  for (const error of Array.isArray(errors) ? errors : []) {
    const label = resolveKeyedPath(normalizeErrorPath(error?.path), document);
    const list = byPath.get(label) || [];
    list.push(String(error?.message || "Invalid value."));
    byPath.set(label, list);
  }
  return byPath;
};

const resolveKeyedPath = (label, document) => {
  if (!label.includes("[key:")) return label;
  let current = document;
  let resolved = "";
  for (const token of label.match(/[^.[\]]+|\[[^\]]+\]/g) || []) {
    if (token.startsWith("[key:")) {
      const key = token.slice(5, -1);
      const index = Array.isArray(current) ? current.findIndex((item) => item?._key === key) : -1;
      resolved += `[${index}]`;
      current = index >= 0 ? current[index] : undefined;
    } else if (token.startsWith("[")) {
      const index = Number(token.slice(1, -1));
      resolved += `[${index}]`;
      current = current?.[index];
    } else {
      resolved = resolved ? `${resolved}.${token}` : token;
      current = current?.[token];
    }
  }
  return resolved;
};

export const newKey = () => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const stableJson = (value) => JSON.stringify(sortKeys(value));

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])])
  );
};

export const newUuid = () => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const toStablePath = (document, path) => {
  const stable = [];
  let current = document;
  for (const segment of path) {
    if (typeof segment === "number" && Array.isArray(current)) {
      const item = current[segment];
      stable.push(item && typeof item === "object" && typeof item._key === "string" ? { _key: item._key } : segment);
      current = item;
    } else {
      stable.push(segment);
      current = current?.[segment];
    }
  }
  return stable;
};

export const resolveStablePath = (document, stablePath) => {
  const path = [];
  let current = document;
  for (const segment of stablePath) {
    if (segment && typeof segment === "object") {
      if (!Array.isArray(current)) return null;
      const index = current.findIndex((item) => item?._key === segment._key);
      if (index < 0) return null;
      path.push(index);
      current = current[index];
    } else {
      if (typeof segment === "number" && (!Array.isArray(current) || segment >= current.length)) return null;
      path.push(segment);
      current = current?.[segment];
    }
  }
  return path;
};

export const contentErrorLabel = (type, rawPath) => {
  const path = normalizeErrorPath(rawPath);
  if (!path) return "Document";
  const parts = path.match(/[^.[\]]+|\[\d+\]/g) || [];
  let fields = type?.fields || [];
  const labels = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === "markDefs" && /^\[\d+\]$/.test(parts[index + 1] || "")) {
      const link = Number(parts[++index].slice(1, -1)) + 1;
      return `Link ${link} in ${labels.join(" › ")}`;
    }
    if (/^\[\d+\]$/.test(part)) { labels.push(`Item ${Number(part.slice(1, -1)) + 1}`); continue; }
    const field = fields.find(entry => entry.name === part);
    labels.push(field?.title || part);
    fields = field?.fields || field?.of?.find(entry => entry.fields)?.fields || [];
  }
  return labels.join(" › ");
};
