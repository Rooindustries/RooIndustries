const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const REQUIRED_OAUTH_KEYS = Object.freeze([
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_PARTICIPANT_ROLE_ID",
  "DISCORD_HOST_ROLE_ID",
]);

const trim = (value) => String(value || "").trim();

const safeUrl = (value) => {
  const raw = trim(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
};

const resolveBaseUrl = (baseUrl = "", env = process.env) => {
  const explicit = safeUrl(baseUrl);
  if (explicit) return explicit;

  const configured = safeUrl(env.TOURNEY_BASE_URL || env.NEXT_PUBLIC_SITE_URL);
  if (configured) return configured;

  const vercelUrl = trim(env.VERCEL_URL);
  if (vercelUrl) return `https://${vercelUrl}`;

  return "https://www.rooindustries.com";
};

const buildRedirectUri = ({ baseUrl = "", env = process.env } = {}) => {
  const configured = safeUrl(env.DISCORD_OAUTH_REDIRECT_URI);
  if (configured) return configured;
  return new URL(
    "/api/tourney/discord/callback",
    resolveBaseUrl(baseUrl, env)
  ).toString();
};

export const getTourneyDiscordInviteUrl = (env = process.env) =>
  safeUrl(env.TOURNEY_DISCORD_INVITE_URL);

export const getTourneyDiscordOAuthConfig = ({
  baseUrl = "",
  env = process.env,
} = {}) => {
  const values = {
    clientId: trim(env.DISCORD_CLIENT_ID),
    clientSecret: trim(env.DISCORD_CLIENT_SECRET),
    botToken: trim(env.DISCORD_BOT_TOKEN),
    guildId: trim(env.DISCORD_GUILD_ID),
    participantRoleId: trim(env.DISCORD_PARTICIPANT_ROLE_ID),
    hostRoleId: trim(env.DISCORD_HOST_ROLE_ID),
    redirectUri: buildRedirectUri({ baseUrl, env }),
    inviteUrl: getTourneyDiscordInviteUrl(env),
    apiBaseUrl: trim(env.DISCORD_API_BASE_URL) || DISCORD_API_BASE_URL,
    authorizeUrl: trim(env.DISCORD_AUTHORIZE_URL) || DISCORD_AUTHORIZE_URL,
  };
  const missing = REQUIRED_OAUTH_KEYS.filter((key) => !trim(env[key]));
  const explicitlyDisabled = trim(env.TOURNEY_DISCORD_OAUTH_ENABLED) === "0";

  return {
    ...values,
    enabled: !explicitlyDisabled && missing.length === 0,
    explicitlyDisabled,
    missing,
  };
};

export const getTourneyDiscordRoleConfig = (env = process.env) => {
  const config = {
    apiBaseUrl: trim(env.DISCORD_API_BASE_URL) || DISCORD_API_BASE_URL,
    botToken: trim(env.DISCORD_BOT_TOKEN),
    guildId: trim(env.DISCORD_GUILD_ID),
    hostRoleId: trim(env.DISCORD_HOST_ROLE_ID),
    participantRoleId: trim(env.DISCORD_PARTICIPANT_ROLE_ID),
  };
  const snowflake = /^[0-9]{5,30}$/;
  const enabled = Boolean(
    config.botToken &&
      snowflake.test(config.guildId) &&
      snowflake.test(config.hostRoleId) &&
      snowflake.test(config.participantRoleId) &&
      config.hostRoleId !== config.participantRoleId
  );
  return { ...config, enabled };
};
