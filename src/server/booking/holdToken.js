import crypto from "crypto";

const HOLD_TOKEN_SECRET =
  String(process.env.HOLD_TOKEN_SECRET || "").trim() ||
  (process.env.NODE_ENV === "production" ? "" : "dev_hold_token_secret");

const base64UrlEncode = (value) =>
  Buffer.from(value).toString("base64url");

const base64UrlDecode = (value) =>
  Buffer.from(String(value || ""), "base64url").toString("utf8");

const sign = (input) =>
  crypto.createHmac("sha256", HOLD_TOKEN_SECRET).update(input).digest("base64url");

const assertSecret = () => {
  if (!HOLD_TOKEN_SECRET) {
    throw new Error(
      "HOLD_TOKEN_SECRET is required"
    );
  }
};

export const issueHoldToken = ({
  holdId,
  startTimeUTC,
  expiresAt,
  holdNonce = "",
  backend = "sanity",
}) => {
  assertSecret();
  const payload = {
    v: 3,
    hid: holdId,
    st: startTimeUTC,
    exp: Math.floor(new Date(expiresAt).getTime() / 1000),
    ...(holdNonce ? { n: holdNonce } : {}),
    be: backend === "supabase" ? "supabase" : "sanity",
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
};

export const verifyHoldToken = ({
  token,
  holdId,
  startTimeUTC,
  holdNonce = "",
  backend = "",
  ignoreExpiry = false,
}) => {
  try {
    assertSecret();
    if (!token || typeof token !== "string" || !token.includes(".")) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encoded, signature] = parts;
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
    if (holdNonce && payload.n !== holdNonce) return null;
    if (backend && (payload.be === "supabase" ? "supabase" : "sanity") !== backend) {
      return null;
    }
    if (!ignoreExpiry && payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
};
