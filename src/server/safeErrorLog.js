const cleanLabel = (value, fallback) => {
  const normalized = String(value || "")
    .replace(/[^a-z0-9_.:-]/gi, "_")
    .slice(0, 80);
  return normalized || fallback;
};

export const getSafeErrorMetadata = (error) => ({
  name: cleanLabel(error?.name, "Error"),
  code: cleanLabel(error?.code, "unknown"),
  status: Number(error?.status || error?.statusCode || 0) || 0,
  ...(error?.documentType === "referral" && error?.id
    ? { referralId: cleanLabel(error.id, "unknown") }
    : {}),
});

export const getSafeErrorCode = (error, fallback = "server_error") => {
  const code = getSafeErrorMetadata(error).code;
  return code === "unknown" ? cleanLabel(fallback, "server_error") : code;
};

export const logSafeError = (label, error) => {
  const metadata = getSafeErrorMetadata(error);
  console.error(String(label || "Server error"), metadata);
  globalThis[Symbol.for("roo.reportServerError")]?.(String(label || "Server error"), error, metadata);
};

export const logSafeWarn = (label, error) => {
  console.warn(String(label || "Server warning"), getSafeErrorMetadata(error));
};

const SAFE_EVENT_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const safeEventValue = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
  return text && !EMAIL_LIKE.test(text) ? text : undefined;
};

export const logSafeEvent = (label, fields = {}) => {
  const safe = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const cleaned = SAFE_EVENT_KEY.test(key) ? safeEventValue(value) : undefined;
    if (cleaned !== undefined) safe[key] = cleaned;
  }
  console.log(JSON.stringify({ event: cleanLabel(label, "event"), ...safe }));
};
