import { logSafeError } from "../safeErrorLog.js";

export const buildTourneyPublicError = (error, fallbackMessage) => {
  const suppliedStatus = Number(error?.status || error?.statusCode || 0);
  const status = suppliedStatus >= 400 && suppliedStatus < 500 ? suppliedStatus : 500;

  if (status === 500) {
    logSafeError("Tournament request failed", error);
  }

  return {
    status,
    message:
      status < 500 && String(error?.message || "").trim()
        ? String(error.message).trim()
        : fallbackMessage,
    ...(status < 500 && Array.isArray(error?.errors)
      ? { errors: error.errors }
      : {}),
    ...(status < 500 && String(error?.code || "").trim()
      ? { code: String(error.code).trim() }
      : {}),
  };
};
