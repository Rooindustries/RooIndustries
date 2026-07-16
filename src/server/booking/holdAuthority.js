import { resolveSupabaseRuntimePolicy } from "../supabase/runtime.js";
import envValue from "../supabase/envValue.cjs";

const { normalizeBackend } = envValue;

export const selectHoldAuthority = ({
  tokenPayload,
  fallbackBackend = "",
  policy = resolveSupabaseRuntimePolicy(),
} = {}) => {
  const policyBackend = normalizeBackend(
    policy.commercePrimaryBackend,
    "supabase"
  );
  if (policy.commerceFailoverGeneration >= 1) {
    return policyBackend;
  }
  if (tokenPayload?.hid) {
    return normalizeBackend(tokenPayload.be, "sanity");
  }
  return normalizeBackend(fallbackBackend, policyBackend);
};
