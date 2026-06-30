import crypto from "crypto";
import {
  getTourneyDiscordInviteUrl,
  getTourneyDiscordOAuthConfig,
} from "./discordConfig.js";

const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 15;
const DISCORD_SCOPES = Object.freeze(["identify", "guilds.join"]);

const base64UrlEncode = (value) => Buffer.from(value).toString("base64url");
const base64UrlDecode = (value) =>
  Buffer.from(String(value || ""), "base64url").toString("utf8");

const timingSafeEqualString = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const sign = (input, secret) =>
  crypto.createHmac("sha256", secret).update(input).digest("base64url");

const getStateSecret = (env = process.env) => {
  const configured = String(
    env.TOURNEY_DISCORD_STATE_SECRET || env.TOURNEY_SESSION_SECRET || ""
  ).trim();
  if (configured) return configured;
  return env.NODE_ENV === "production" ? "" : "dev_tourney_discord_state_secret";
};

const createSignedToken = ({
  purpose,
  payload,
  maxAgeSeconds,
  env = process.env,
} = {}) => {
  const secret = getStateSecret(env);
  if (!secret || !purpose) return "";

  const now = Math.floor(Date.now() / 1000);
  const body = {
    v: 1,
    p: purpose,
    iat: now,
    ...(maxAgeSeconds ? { exp: now + maxAgeSeconds } : {}),
    ...payload,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(body));
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
};

const readSignedToken = ({
  token,
  purpose,
  env = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
  ignoreExpiration = false,
} = {}) => {
  try {
    const secret = getStateSecret(env);
    if (!secret || !token || !purpose) return null;
    const [encodedPayload, signature] = String(token).split(".");
    if (!encodedPayload || !signature) return null;

    const expected = sign(encodedPayload, secret);
    if (!timingSafeEqualString(signature, expected)) return null;

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (
      payload?.p !== purpose ||
      (!ignoreExpiration && (!payload.exp || payload.exp <= nowSeconds))
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
};

const normalizeReturnTo = (value) => {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/tourney";
  return raw;
};

export const createTourneyDiscordEmailToken = ({
  player,
  env = process.env,
  maxAgeSeconds = 0,
} = {}) =>
  createSignedToken({
    purpose: "discord-email-link",
    env,
    maxAgeSeconds,
    payload: {
      playerId: player?.id || "",
    },
  });

export const readTourneyDiscordEmailToken = ({ token, env = process.env } = {}) => {
  const payload = readSignedToken({
    token,
    purpose: "discord-email-link",
    env,
    ignoreExpiration: true,
  });
  if (!payload?.playerId) return null;
  return {
    playerId: String(payload.playerId),
  };
};

export const createTourneyDiscordOAuthStateToken = ({
  player,
  returnTo = "/tourney",
  env = process.env,
  maxAgeSeconds = OAUTH_STATE_MAX_AGE_SECONDS,
} = {}) =>
  createSignedToken({
    purpose: "discord-oauth-state",
    env,
    maxAgeSeconds,
    payload: {
      playerId: player?.id || "",
      version: String(player?.version || "1"),
      returnTo: normalizeReturnTo(returnTo),
      nonce: crypto.randomBytes(16).toString("base64url"),
    },
  });

export const readTourneyDiscordOAuthStateToken = ({
  token,
  env = process.env,
} = {}) => {
  const payload = readSignedToken({
    token,
    purpose: "discord-oauth-state",
    env,
  });
  if (!payload?.playerId || !payload?.version) return null;
  return {
    playerId: String(payload.playerId),
    version: String(payload.version),
    returnTo: normalizeReturnTo(payload.returnTo),
  };
};

export const buildTourneyDiscordStartUrl = ({
  player,
  baseUrl,
  env = process.env,
} = {}) => {
  const oauthConfig = getTourneyDiscordOAuthConfig({ baseUrl, env });
  if (!oauthConfig.enabled) return getTourneyDiscordInviteUrl(env);

  const token = createTourneyDiscordEmailToken({ player, env });
  if (!token) return getTourneyDiscordInviteUrl(env);

  const url = new URL("/api/tourney/discord/start", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
};

export const buildDiscordAuthorizationUrl = ({
  state,
  config,
} = {}) => {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", DISCORD_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  return url.toString();
};

const parseDiscordResponseBody = async (response) => {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};

const getDiscordError = async (response, fallback) => {
  const body = await parseDiscordResponseBody(response);
  return (
    body?.message ||
    body?.error_description ||
    body?.error ||
    `${fallback} (${response.status})`
  );
};

export async function exchangeDiscordOAuthCode({
  code,
  config,
  fetchImpl = fetch,
} = {}) {
  const body = new URLSearchParams();
  body.set("client_id", config.clientId);
  body.set("client_secret", config.clientSecret);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", config.redirectUri);

  const response = await fetchImpl(`${config.apiBaseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(await getDiscordError(response, "Discord token exchange failed"));
  }

  const token = await response.json();
  if (!token?.access_token) {
    throw new Error("Discord token exchange did not return an access token.");
  }
  return token;
}

export async function fetchDiscordCurrentUser({
  accessToken,
  config,
  fetchImpl = fetch,
} = {}) {
  const response = await fetchImpl(`${config.apiBaseUrl}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(await getDiscordError(response, "Unable to read Discord user"));
  }

  const user = await response.json();
  if (!user?.id) {
    throw new Error("Discord user response did not include an id.");
  }
  return user;
}

export async function assignTourneyDiscordParticipantRole({
  accessToken,
  userId,
  config,
  fetchImpl = fetch,
} = {}) {
  const headers = {
    Authorization: `Bot ${config.botToken}`,
    "Content-Type": "application/json",
  };
  const memberUrl = `${config.apiBaseUrl}/guilds/${config.guildId}/members/${userId}`;
  const roleUrl = `${memberUrl}/roles/${config.participantRoleId}`;

  const memberResponse = await fetchImpl(memberUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      access_token: accessToken,
    }),
  });
  if (!memberResponse.ok && memberResponse.status !== 204) {
    throw new Error(
      await getDiscordError(memberResponse, "Unable to add Discord guild member")
    );
  }

  const roleResponse = await fetchImpl(roleUrl, {
    method: "PUT",
    headers: { Authorization: `Bot ${config.botToken}` },
  });
  if (!roleResponse.ok && roleResponse.status !== 204) {
    throw new Error(
      await getDiscordError(roleResponse, "Unable to assign Discord role")
    );
  }

  return {
    joined: memberResponse.status === 201,
    alreadyMember: memberResponse.status === 204,
    roleAssigned: true,
  };
}
