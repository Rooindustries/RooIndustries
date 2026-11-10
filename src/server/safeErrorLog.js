const cleanLabel = (value, fallback) => {
  const normalized = String(value || "")
    .replace(/[^a-z0-9_.:-]/gi, "_")
    .slice(0, 80);
  return normalized || fallback;
};

export const getSafeErrorMetadata = (error) => {
  const metadata = {
    name: cleanLabel(error?.name, "Error"),
    code: cleanLabel(error?.code, "unknown"),
    status: Number(error?.status || error?.statusCode || 0) || 0,
  };
  if (error?.documentType) {
    metadata.documentType = ["package", "booking", "paymentRecord", "referral"].includes(error.documentType)
      ? error.documentType : "other";
    metadata.documentCount = 1;
    if (Number.isSafeInteger(error.bytes) && error.bytes >= 0) metadata.documentBytes = error.bytes;
    if (metadata.documentType === "package" && typeof error.id === "string" &&
      /^[a-z0-9_.-]{1,128}$/i.test(error.id)) metadata.packageId = error.id;
  }
  return metadata;
};

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
