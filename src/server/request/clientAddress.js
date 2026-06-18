import { isIP } from "net";

export const UNKNOWN_CLIENT_ADDRESS = "unknown";

const normalizeHeaderValue = (value) => {
  if (Array.isArray(value)) return value.join(",");
  return String(value || "").trim();
};

const firstValidIp = (value) => {
  const parts = normalizeHeaderValue(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.find((part) => isIP(part) !== 0) || "";
};

export const getClientAddressFromRequestHeaders = (headers = {}) => {
  const forwarded = firstValidIp(
    headers["x-forwarded-for"] || headers["X-Forwarded-For"]
  );
  if (forwarded) return forwarded;

  const realIp = firstValidIp(headers["x-real-ip"] || headers["X-Real-IP"]);
  if (realIp) return realIp;

  return UNKNOWN_CLIENT_ADDRESS;
};

export const getClientAddressFromFetchHeaders = (headers) => {
  const forwarded = firstValidIp(headers?.get?.("x-forwarded-for"));
  if (forwarded) return forwarded;

  const realIp = firstValidIp(headers?.get?.("x-real-ip"));
  if (realIp) return realIp;

  return UNKNOWN_CLIENT_ADDRESS;
};
