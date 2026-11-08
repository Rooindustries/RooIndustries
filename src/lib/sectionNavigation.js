export const SECTION_HASHES = Object.freeze({
  benefits: "#services",
  plans: "#packages",
  howItWorks: "#how-it-works",
  faq: "#faq",
  upgradePath: "#upgrade-path",
  trust: "#trust",
});

export const SECTION_IDS = Object.freeze(
  Object.values(SECTION_HASHES).map((hash) => hash.slice(1))
);

const PENDING_SECTION_KEY = "roo_pending_section";
export const ROUTE_TRANSITION_KEY = "roo_route_transition";
export const SECTION_TRIP_ENTRY = "__rooSectionTrip";

export const isSupersededSectionTrip = (state, trip) =>
  typeof trip?.key === "string" && Boolean(trip.superseded) && state?.sectionTrip === trip.key;

export const withoutSupersededSectionTrip = (state, trip) => {
  if (!isSupersededSectionTrip(state, trip)) return state;
  const { sectionTrip, ...winningState } = state;
  return winningState;
};

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

export const announceSectionTarget = (hash = "") => {
  if (typeof window === "undefined") return;
  const normalized = normalizeSectionHash(hash);
  if (!normalized) return;
  window.dispatchEvent(
    new CustomEvent("roo:pending-section-target", {
      detail: { hash: normalized },
    })
  );
};

export const writePendingSectionTarget = (hash = "", path) => {
  const normalized = normalizeSectionHash(hash);
  if (!normalized) return;
  try {
    sessionStorage.setItem(PENDING_SECTION_KEY, JSON.stringify({ hash: normalized, path }));
  } catch {}
  announceSectionTarget(normalized);
};

export const readPendingSectionTarget = (path = typeof window === "undefined" ? "" : window.location.pathname) => {
  try {
    const raw = sessionStorage.getItem(PENDING_SECTION_KEY);
    if (!raw) return "";
    const pending = JSON.parse(raw);
    const hash = typeof pending?.hash === "string" ? normalizeSectionHash(pending.hash) : "";
    if (!hash || pending.path !== path) {
      clearPendingSectionTarget();
      return "";
    }
    return hash;
  } catch {
    clearPendingSectionTarget();
    return "";
  }
};

export const consumePendingSectionTarget = (path) => {
  const hash = readPendingSectionTarget(path);
  clearPendingSectionTarget();
  return hash;
};

export const clearPendingSectionTarget = () => {
  try {
    sessionStorage.removeItem(PENDING_SECTION_KEY);
  } catch {}
};

export const writeRouteTransitionIntent = (hash) => {
  try {
    sessionStorage.setItem(ROUTE_TRANSITION_KEY, JSON.stringify({ hash, ts: Date.now() }));
  } catch {}
};

export const consumeRouteTransitionIntent = () => {
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
  try {
    sessionStorage.removeItem(ROUTE_TRANSITION_KEY);
  } catch {}
};
