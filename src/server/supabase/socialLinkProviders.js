// The providers a person can link to an existing account after signing in with
// one that is not linked yet. Kept in its own dependency-free module so a page or
// a client component can name a provider without importing the server-only link
// machinery (and, through it, bcrypt and the Supabase admin client).
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
