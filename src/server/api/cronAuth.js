import crypto from "node:crypto";

const readAuthorizationHeader = (request) => {
  const headers = request?.headers;
  if (typeof headers?.get === "function") {
    return headers.get("authorization");
  }
  return headers?.authorization || headers?.Authorization || "";
};

export const authorizeCronRequest = (request, { env = process.env } = {}) => {
  const configured = String(env.CRON_SECRET || "").trim();
  if (!configured) {
    const error = new Error("CRON_SECRET is required.");
    error.status = 500;
    throw error;
  }

  const authorization = String(readAuthorizationHeader(request) || "").trim();
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  const provided = String(match?.[1] || "").trim();
  const providedBuffer = Buffer.from(provided);
  const configuredBuffer = Buffer.from(configured);
  const authorized =
    providedBuffer.length === configuredBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, configuredBuffer);
  if (!authorized) {
    const error = new Error("Unauthorized request.");
    error.status = 403;
    throw error;
  }
};
