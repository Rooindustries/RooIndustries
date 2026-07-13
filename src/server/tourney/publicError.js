import { logSafeError } from "../safeErrorLog.js";

export const buildTourneyPublicError = (error, fallbackMessage) => {
  const suppliedStatus = Number(error?.status || error?.statusCode || 0);
  const safeUnavailable = suppliedStatus === 503 &&
    String(error?.code || "") === "TOURNEY_WRITES_PAUSED";
  const status = suppliedStatus >= 400 && suppliedStatus < 500
    ? suppliedStatus
    : safeUnavailable ? 503 : 500;
  const exposeError = status < 500 || safeUnavailable;

  if (status === 500) {
    logSafeError("Tournament request failed", error);
  }

  return {
    status,
    message:
      exposeError && String(error?.message || "").trim()
        ? String(error.message).trim()
        : fallbackMessage,
    ...(exposeError && Array.isArray(error?.errors)
      ? { errors: error.errors }
      : {}),
    ...(exposeError && String(error?.code || "").trim()
      ? { code: String(error.code).trim() }
      : {}),
  };
};
