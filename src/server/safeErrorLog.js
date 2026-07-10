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
});

export const getSafeErrorCode = (error, fallback = "server_error") => {
  const code = getSafeErrorMetadata(error).code;
  return code === "unknown" ? cleanLabel(fallback, "server_error") : code;
};

export const logSafeError = (label, error) => {
  console.error(String(label || "Server error"), getSafeErrorMetadata(error));
};
