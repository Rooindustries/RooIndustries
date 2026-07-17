import crypto from "crypto";
import {
  getTourneyDiscordInviteUrl,
  getTourneyDiscordOAuthConfig,
} from "./discordConfig.js";

const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 15;
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
    const parts = String(token).split(".");
    if (parts.length !== 2) return null;
    const [encodedPayload, signature] = parts;
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
    nonce: String(payload.nonce || ""),
  };
};

export const buildTourneyDiscordStartUrl = ({
  baseUrl,
  env = process.env,
} = {}) => {
  const oauthConfig = getTourneyDiscordOAuthConfig({ baseUrl, env });
  if (!oauthConfig.enabled) return getTourneyDiscordInviteUrl(env);
  return new URL("/tourney/discord", baseUrl).toString();
};
