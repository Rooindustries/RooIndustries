import crypto from "crypto";

const HOLD_TOKEN_SECRET =
  process.env.HOLD_TOKEN_SECRET ||
  process.env.REF_SESSION_SECRET ||
  (process.env.NODE_ENV === "production" ? "" : "dev_hold_token_secret");

const base64UrlEncode = (value) =>
  Buffer.from(value).toString("base64url");

const base64UrlDecode = (value) =>
  Buffer.from(String(value || ""), "base64url").toString("utf8");

const sign = (input) =>
  crypto.createHmac("sha256", HOLD_TOKEN_SECRET).update(input).digest("base64url");

const assertSecret = () => {
  if (!HOLD_TOKEN_SECRET) {
    throw new Error("HOLD_TOKEN_SECRET (or REF_SESSION_SECRET) is required");
  }
};

export const issueHoldToken = ({ holdId, startTimeUTC, expiresAt }) => {
  assertSecret();
  const payload = {
    v: 1,
    hid: holdId,
    st: startTimeUTC,
    exp: Math.floor(new Date(expiresAt).getTime() / 1000),
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
};

export const verifyHoldToken = ({ token, holdId, startTimeUTC }) => {
  try {
    assertSecret();
    if (!token || typeof token !== "string" || !token.includes(".")) return null;
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) return null;

    const expected = sign(encoded);
    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(encoded));
    if (!payload?.hid || !payload?.exp) return null;
    if (holdId && payload.hid !== holdId) return null;
    if (startTimeUTC && payload.st && payload.st !== startTimeUTC) return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
};
