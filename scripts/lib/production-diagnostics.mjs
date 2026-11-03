export const redact = (value) => {
  let text = String(value).replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, raw => {
    try {
      const url = new URL(raw);
      let changed = false;
      if (url.username || url.password) {
        url.username = "redacted";
        url.password = "";
        changed = true;
      }
      for (const key of url.searchParams.keys()) {
        url.searchParams.set(key, "redacted");
        changed = true;
      }
      if (url.hash) { url.hash = "redacted"; changed = true; }
      return changed ? url.href : raw;
    } catch {
      return raw.replace(/\/\/[^/\s]*@/, "//redacted@");
    }
  });
  for (const [key, secret] of Object.entries(process.env)) {
    if (!/TOKEN|SECRET|PASSWORD|DSN/.test(key)) continue;
    for (const value of new Set([secret, secret.trim()])) {
      if (value.length >= 4) text = text.split(value).join("[redacted]").split(encodeURIComponent(value)).join("[redacted]");
    }
  }
  return text;
};

export const log = (...values) => console.log(...values.map(redact));
export const logError = (...values) => console.error(...values.map(redact));
export const redactObject = value => {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item)]));
  return value;
};
export const logJson = value => console.log(JSON.stringify(redactObject(value), null, 2));
export const annotate = (level, message) => {
  const safe = redact(message);
  console.log(process.env.GITHUB_ACTIONS === "true"
    ? `::${level}::${safe.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`
    : `${level}: ${safe}`);
};

export const deploymentOrigin = value => {
  let url;
  try { url = new URL(value); } catch { throw new Error("Deployment URL must be a credential-free HTTPS origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Deployment URL must be a credential-free HTTPS origin.");
  }
  return url.origin;
};

export const isLoopback = value => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
};
