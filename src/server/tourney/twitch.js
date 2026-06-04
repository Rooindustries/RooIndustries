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
