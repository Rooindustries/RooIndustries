import { resolveSupabaseRuntimePolicy } from "../supabase/runtime.js";

export const selectHoldAuthority = ({
  tokenPayload,
  fallbackBackend = "sanity",
  policy = resolveSupabaseRuntimePolicy(),
} = {}) => {
  if (
    policy.commercePrimaryBackend === "supabase" &&
    policy.commerceFailoverGeneration >= 1
  ) {
    return "supabase";
  }
  if (tokenPayload?.hid) {
    return tokenPayload.be === "supabase" ? "supabase" : "sanity";
  }
  return fallbackBackend === "supabase" ? "supabase" : "sanity";
};
