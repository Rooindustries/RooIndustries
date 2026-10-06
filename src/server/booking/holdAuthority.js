import envValue from "../supabase/envValue.cjs";
const { resolveStoreBackend } = envValue;
export const selectHoldAuthority = ({ tokenPayload, fallbackBackend, policy } = {}) => {
  if (tokenPayload?.hid) return resolveStoreBackend(tokenPayload.be);
  return resolveStoreBackend(fallbackBackend ?? policy?.commercePrimaryBackend);
};
