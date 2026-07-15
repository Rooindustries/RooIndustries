import crypto from "node:crypto";

const VERSION = "v1";
const AAD = Buffer.from("roo-referral-email-token:v1", "utf8");

const decodeCanonicalBase64Url = (value) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error();
  return decoded;
};

const resolveKey = (env = process.env) => {
  const secret = String(env.REF_SESSION_SECRET || "").trim();
  if (secret.length < 32) {
    throw new Error("Referral email token sealing is not configured.");
  }
  return crypto
    .createHash("sha256")
    .update(`roo-referral-email-token:${secret}`)
    .digest();
};

export const sealReferralEmailToken = (token, env = process.env) => {
  const value = String(token || "");
  if (!value || value.length > 256) {
    throw new Error("Referral email token is invalid.");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", resolveKey(env), iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
};

export const unsealReferralEmailToken = (sealed, env = process.env) => {
  const parts = String(sealed || "").split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Sealed referral email token is invalid.");
  }
  try {
    const iv = decodeCanonicalBase64Url(parts[1]);
    const encrypted = decodeCanonicalBase64Url(parts[2]);
    const authTag = decodeCanonicalBase64Url(parts[3]);
    if (iv.length !== 12 || authTag.length !== 16 || encrypted.length < 1) {
      throw new Error();
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", resolveKey(env), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(authTag);
    const token = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
    if (!token || token.length > 256) throw new Error();
    return token;
  } catch {
    throw new Error("Sealed referral email token is invalid.");
  }
};
