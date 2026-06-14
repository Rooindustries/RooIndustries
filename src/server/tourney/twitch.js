const TWITCH_LOGIN_PATTERN = /^[a-z0-9_]{3,25}$/i;
const TWITCH_RESERVED_PATHS = new Set([
  "directory",
  "downloads",
  "jobs",
  "p",
  "popout",
  "settings",
  "videos",
]);
const TWITCH_PROFILE_LOOKUP_LIMIT = 100;
const TWITCH_PROFILE_CACHE_MS = 6 * 60 * 60 * 1000;
const TWITCH_PROFILE_NEGATIVE_CACHE_MS = 15 * 60 * 1000;
const TWITCH_REQUEST_TIMEOUT_MS = 4500;
const TWITCH_USERS_API = "https://api.twitch.tv/helix/users";
const TWITCH_TOKEN_API = "https://id.twitch.tv/oauth2/token";

const TWITCH_CACHE =
  globalThis.__rooTourneyTwitchCache ||
  (globalThis.__rooTourneyTwitchCache = {
    token: "",
    tokenExpiresAt: 0,
    profileImages: new Map(),
  });

const normalizeLogin = (value) => {
  const login = String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
  return TWITCH_LOGIN_PATTERN.test(login) ? login : "";
};

export const normalizeTwitchUsername = (value) => {
  const login = String(value || "").trim().toLowerCase();
  return TWITCH_LOGIN_PATTERN.test(login) ? login : "";
};

export const extractTwitchLogin = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const compact = raw.replace(/^@+/, "");
  const withoutHost = compact
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "")
    .replace(/^(www\.)?twitch\.tv\//i, "");
  if (withoutHost !== compact) {
    const [firstPath] = withoutHost.split(/[/?#]/);
    const login = normalizeLogin(firstPath);
    return TWITCH_RESERVED_PATHS.has(login) ? "" : login;
  }

  return normalizeLogin(compact);
};

export const buildTwitchChannelUrl = (value) => {
  const login = extractTwitchLogin(value);
  if (login) return `https://www.twitch.tv/${login}`;
  return "";
};

export const formatTwitchLabel = (value) => {
  const login = extractTwitchLogin(value);
  if (login) return login;
  return String(value || "").trim();
};

const nowMs = () => Date.now();

const shouldSkipProfileLookup = (env) => {
  const nodeEnv = env?.NODE_ENV || process.env.NODE_ENV;
  return (
    env?.TOURNEY_TWITCH_PROFILE_LOOKUP === "0" ||
    (env?.TOURNEY_TWITCH_PROFILE_LOOKUP !== "1" && nodeEnv === "test")
  );
};

const isSafeTwitchImageUrl = (value) => {
  try {
    const url = new URL(String(value || "").replaceAll("&amp;", "&"));
    return (
      url.protocol === "https:" &&
      (url.hostname === "static-cdn.jtvnw.net" ||
        url.hostname.endsWith(".jtvnw.net") ||
        url.hostname.endsWith(".twitchcdn.net"))
    );
  } catch {
    return false;
  }
};

const normalizeProfileImageUrl = (value) => {
  const cleaned = String(value || "").replaceAll("&amp;", "&").trim();
  return isSafeTwitchImageUrl(cleaned) ? cleaned : "";
};

export const extractTwitchProfileImageFromHtml = (html) => {
  const source = String(html || "");
  const match =
    source.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i
    ) ||
    source.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i
    );
  return normalizeProfileImageUrl(match?.[1]);
};

const withTimeoutSignal = () =>
  typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(TWITCH_REQUEST_TIMEOUT_MS)
    : undefined;

const getCachedProfileImage = (login) => {
  const cached = TWITCH_CACHE.profileImages.get(login);
  if (!cached || cached.expiresAt <= nowMs()) return null;
  return cached.url || "";
};

const setCachedProfileImage = (login, url) => {
  TWITCH_CACHE.profileImages.set(login, {
    url,
    expiresAt:
      nowMs() + (url ? TWITCH_PROFILE_CACHE_MS : TWITCH_PROFILE_NEGATIVE_CACHE_MS),
  });
};

const getTwitchAppAccessToken = async ({ env, fetchImpl }) => {
  const staticToken = String(env?.TWITCH_APP_ACCESS_TOKEN || "").trim();
  if (staticToken) return staticToken;

  const clientId = String(env?.TWITCH_CLIENT_ID || "").trim();
  const clientSecret = String(env?.TWITCH_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return "";
  if (TWITCH_CACHE.token && TWITCH_CACHE.tokenExpiresAt > nowMs() + 60000) {
    return TWITCH_CACHE.token;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });
  const response = await fetchImpl(TWITCH_TOKEN_API, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: withTimeoutSignal(),
  });
  if (!response.ok) return "";

  const data = await response.json().catch(() => ({}));
  const accessToken = String(data.access_token || "").trim();
  if (!accessToken) return "";

  TWITCH_CACHE.token = accessToken;
  TWITCH_CACHE.tokenExpiresAt =
    nowMs() + Math.max(Number(data.expires_in || 0) - 60, 300) * 1000;
  return accessToken;
};

const fetchProfileImagesFromHelix = async ({ logins, env, fetchImpl }) => {
  const clientId = String(env?.TWITCH_CLIENT_ID || "").trim();
  const token = await getTwitchAppAccessToken({ env, fetchImpl });
  if (!clientId || !token) return new Map();

  const url = new URL(TWITCH_USERS_API);
  for (const login of logins) url.searchParams.append("login", login);

  const response = await fetchImpl(url.toString(), {
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${token}`,
    },
    signal: withTimeoutSignal(),
  });
  if (!response.ok) return new Map();

  const data = await response.json().catch(() => ({}));
  const results = new Map();
  for (const user of Array.isArray(data.data) ? data.data : []) {
    const login = normalizeTwitchUsername(user.login);
    const imageUrl = normalizeProfileImageUrl(user.profile_image_url);
    if (login && imageUrl) results.set(login, imageUrl);
  }
  return results;
};

const fetchProfileImageFromPublicPage = async ({ login, fetchImpl }) => {
  const response = await fetchImpl(`https://www.twitch.tv/${login}`, {
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0 RooIndustriesBot/1.0",
    },
    signal: withTimeoutSignal(),
    next: { revalidate: Math.floor(TWITCH_PROFILE_CACHE_MS / 1000) },
  });
  if (!response.ok) return "";
  return extractTwitchProfileImageFromHtml(await response.text());
};

const fetchProfileImagesFromPublicPages = async ({ logins, fetchImpl }) => {
  const entries = await Promise.all(
    logins.map(async (login) => [
      login,
      await fetchProfileImageFromPublicPage({ login, fetchImpl }).catch(() => ""),
    ])
  );
  return new Map(entries.filter(([, imageUrl]) => imageUrl));
};

export async function getTwitchProfileImageMap(
  logins,
  { env = process.env, fetchImpl = fetch } = {}
) {
  if (!Array.isArray(logins) || shouldSkipProfileLookup(env)) return new Map();
  const uniqueLogins = [
    ...new Set(logins.map(normalizeTwitchUsername).filter(Boolean)),
  ].slice(0, TWITCH_PROFILE_LOOKUP_LIMIT);
  if (uniqueLogins.length === 0) return new Map();

  const results = new Map();
  const misses = [];
  for (const login of uniqueLogins) {
    const cached = getCachedProfileImage(login);
    if (cached !== null) {
      if (cached) results.set(login, cached);
    } else {
      misses.push(login);
    }
  }
  if (misses.length === 0) return results;

  const helixResults = await fetchProfileImagesFromHelix({
    logins: misses,
    env,
    fetchImpl,
  }).catch(() => new Map());
  for (const [login, imageUrl] of helixResults.entries()) {
    results.set(login, imageUrl);
    setCachedProfileImage(login, imageUrl);
  }

  const unresolved = misses.filter((login) => !results.has(login));
  if (
    unresolved.length > 0 &&
    String(env?.TWITCH_PROFILE_PAGE_FALLBACK || "1") !== "0"
  ) {
    const publicResults = await fetchProfileImagesFromPublicPages({
      logins: unresolved,
      fetchImpl,
    }).catch(() => new Map());
    for (const [login, imageUrl] of publicResults.entries()) {
      results.set(login, imageUrl);
      setCachedProfileImage(login, imageUrl);
    }
  }

  for (const login of misses) {
    if (!results.has(login)) setCachedProfileImage(login, "");
  }

  return results;
}

export const resetTwitchProfileCacheForTests = () => {
  TWITCH_CACHE.token = "";
  TWITCH_CACHE.tokenExpiresAt = 0;
  TWITCH_CACHE.profileImages = new Map();
};
