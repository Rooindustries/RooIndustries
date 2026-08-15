import crypto from "node:crypto";

const PURPOSE = "tourney-broadcast-overlay";

const normalizeValue = (value) => String(value || "").trim();

const getSecret = (env = process.env) => {
  const secret = normalizeValue(env.TOURNEY_SESSION_SECRET);
  if (!secret) {
    throw Object.assign(new Error("TOURNEY_SESSION_SECRET is required."), {
      code: "tourney_broadcast_secret_missing",
    });
  }
  return secret;
};

const sign = (payload, env) =>
  crypto.createHmac("sha256", getSecret(env)).update(payload).digest("base64url");

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

export const createTourneyBroadcastOverlayToken = ({
  matchId,
  env = process.env,
} = {}) => {
  const normalizedMatchId = Number(matchId);
  if (!Number.isInteger(normalizedMatchId) || normalizedMatchId < 0) {
    throw new Error("A valid match ID is required.");
  }
  const payload = Buffer.from(
    JSON.stringify({ purpose: PURPOSE, matchId: normalizedMatchId })
  ).toString("base64url");
  return `${payload}.${sign(payload, env)}`;
};

export const verifyTourneyBroadcastOverlayToken = ({
  token,
  env = process.env,
} = {}) => {
  const [payload, signature, extra] = normalizeValue(token).split(".");
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload, env))) {
    return { ok: false };
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      claims?.purpose !== PURPOSE ||
      !Number.isInteger(claims?.matchId) ||
      claims.matchId < 0
    ) {
      return { ok: false };
    }
    return { ok: true, matchId: claims.matchId };
  } catch {
    return { ok: false };
  }
};
