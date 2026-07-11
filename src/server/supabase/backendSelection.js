import crypto from "node:crypto";
import {
  resolveSupabaseRuntimePolicy,
  selectCanaryBackend,
} from "./runtime.js";

export const CONTENT_ASSIGNMENT_COOKIE = "roo_content_assignment";
const ASSIGNMENT_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(sanity|supabase)$/;

const parseCookies = (header) =>
  String(header || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((cookies, entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) return cookies;
      const key = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim();
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
      return cookies;
    }, {});

export const selectContentBackend = ({
  cookieHeader = "",
  env = process.env,
} = {}) => {
  const policy = resolveSupabaseRuntimePolicy(env);
  if (policy.primaryBackend === "supabase") {
    return {
      backend: "supabase",
      canaryActive: false,
      assignmentCookie: "",
    };
  }
  if (policy.contentCanaryPercentage < 1) {
    return {
      backend: "sanity",
      canaryActive: false,
      assignmentCookie: "",
    };
  }

  const cookies = parseCookies(cookieHeader);
  const existing = String(cookies[CONTENT_ASSIGNMENT_COOKIE] || "").match(
    ASSIGNMENT_PATTERN
  );
  if (existing) {
    return {
      backend: existing[2],
      canaryActive: true,
      assignmentCookie: "",
    };
  }

  const visitorId = crypto.randomUUID();
  const backend = selectCanaryBackend({
    key: visitorId,
    percentage: policy.contentCanaryPercentage,
  });
  return {
    backend,
    canaryActive: true,
    assignmentCookie: `${visitorId}.${backend}`,
  };
};

export const serializeContentAssignmentCookie = ({
  value,
  secure = process.env.NODE_ENV === "production",
} = {}) => {
  if (!value) return "";
  return [
    `${CONTENT_ASSIGNMENT_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "Max-Age=604800",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
};
