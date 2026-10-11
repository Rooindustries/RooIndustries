export const formatLinkExpiry = (expiresAt) => {
  const expiry = new Date(String(expiresAt || "")).getTime();
  if (!Number.isFinite(expiry)) return "This private link's expiry is unavailable.";
  const remaining = expiry - Date.now();
  if (remaining <= 0) return "This private link has expired.";
  if (remaining < 60_000) return "This private link expires in less than a minute.";
  const minutes = Math.ceil(remaining / 60_000);
  return `This private link expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
};
