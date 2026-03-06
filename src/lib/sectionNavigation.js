export const SECTION_HASHES = Object.freeze({
  benefits: "#services",
  plans: "#packages",
  faq: "#faq",
});

export const SECTION_IDS = Object.freeze(
  Object.values(SECTION_HASHES).map((hash) => hash.slice(1))
);

export const PENDING_SECTION_KEY = "roo_pending_section";
export const ROUTE_TRANSITION_KEY = "roo_route_transition";

export const normalizeSectionHash = (hash = "") => {
  const raw = String(hash || "").trim();
  if (!raw) return "";
  const prefixed = raw.startsWith("#") ? raw : `#${raw}`;
  try {
    return `#${decodeURIComponent(prefixed.slice(1))}`;
  } catch {
    return prefixed;
  }
};

export const buildHomeSectionHref = (hash) => {
  const normalized = normalizeSectionHash(hash);
  return normalized ? `/${normalized}` : "/";
};

export const isHomeSectionHash = (hash = "") => {
  const normalized = normalizeSectionHash(hash);
  if (!normalized) return false;
  return SECTION_IDS.includes(normalized.slice(1));
};

export const writePendingSectionTarget = (hash = "") => {
  if (typeof window === "undefined") return;
  const normalized = normalizeSectionHash(hash);
  if (!normalized) return;
  try {
    sessionStorage.setItem(PENDING_SECTION_KEY, normalized);
  } catch {}
};

export const readPendingSectionTarget = () => {
  if (typeof window === "undefined") return "";
  try {
    return normalizeSectionHash(sessionStorage.getItem(PENDING_SECTION_KEY) || "");
  } catch {
    return "";
  }
};

export const consumePendingSectionTarget = () => {
  if (typeof window === "undefined") return "";
  try {
    const value = normalizeSectionHash(
      sessionStorage.getItem(PENDING_SECTION_KEY) || ""
    );
    sessionStorage.removeItem(PENDING_SECTION_KEY);
    return value;
  } catch {
    return "";
  }
};

export const clearPendingSectionTarget = () => {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(PENDING_SECTION_KEY);
  } catch {}
};

export const writeRouteTransitionIntent = (payload = {}) => {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(
      ROUTE_TRANSITION_KEY,
      JSON.stringify({
        ...payload,
        ts: Date.now(),
      })
    );
  } catch {}
};

export const consumeRouteTransitionIntent = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(ROUTE_TRANSITION_KEY);
    sessionStorage.removeItem(ROUTE_TRANSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
};

export const clearRouteTransitionIntent = () => {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(ROUTE_TRANSITION_KEY);
  } catch {}
};
