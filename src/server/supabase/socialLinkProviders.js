// Shared with client components; keep this module free of server-only link
// dependencies such as bcrypt and the Supabase admin client.
export const PENDING_LINK_PROVIDERS = Object.freeze(["discord", "google"]);

export const PENDING_LINK_PROVIDER_LABELS = Object.freeze({
  discord: "Discord",
  google: "Google",
});

export const normalizePendingLinkProvider = (value) => {
  const provider = String(value || "").trim().toLowerCase();
  return PENDING_LINK_PROVIDERS.includes(provider) ? provider : "discord";
};

export const pendingLinkProviderLabel = (value) =>
  PENDING_LINK_PROVIDER_LABELS[normalizePendingLinkProvider(value)];
