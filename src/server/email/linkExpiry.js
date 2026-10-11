export const formatLinkExpiry = (expiresAt) => {
  const expiry = new Date(String(expiresAt || "")).getTime();
  if (!Number.isFinite(expiry)) return "This private link's expiry is unavailable.";
  if (expiry <= Date.now()) return "This private link has expired.";
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", dateStyle: "medium", timeStyle: "short",
  }).format(new Date(expiry));
  return `This private link expires ${label} UTC.`;
};
