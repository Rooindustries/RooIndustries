import crypto from "crypto";

const secret = () =>
  String(
    process.env.UPGRADE_INTENT_SECRET ||
      process.env.PAYMENT_SESSION_SECRET ||
      process.env.HOLD_TOKEN_SECRET ||
      process.env.REF_SESSION_SECRET ||
      (process.env.NODE_ENV === "production" ? "" : "dev_upgrade_intent_secret")
  ).trim();

const normalize = (value) => String(value || "").trim().toLowerCase();
const normalizePackageTitle = (value) =>
  normalize(value).replace(/\s*\(upgrade\)\s*$/i, "").trim();
const digestEmail = (email) =>
  crypto.createHash("sha256").update(normalize(email)).digest("base64url");
const sign = (encoded, key) =>
  crypto.createHmac("sha256", key).update(encoded).digest("base64url");

export const issueUpgradeIntentToken = ({
  bookingId,
  email,
  targetPackageTitle,
  expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(),
}) => {
  const key = secret();
  if (!key) throw new Error("UPGRADE_INTENT_SECRET is required.");
  const payload = {
    v: 1,
    bid: String(bookingId || "").trim(),
    emh: digestEmail(email),
    pkg: normalizePackageTitle(targetPackageTitle),
    exp: Math.floor(new Date(expiresAt).getTime() / 1000),
    n: crypto.randomUUID(),
  };
  if (!payload.bid || !payload.pkg || !Number.isFinite(payload.exp)) {
    throw new Error("Upgrade intent is incomplete.");
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, key)}`;
};

export const verifyUpgradeIntentToken = ({
  token,
  bookingId,
  email,
  targetPackageTitle,
}) => {
  try {
    const key = secret();
    if (!key || typeof token !== "string") return null;
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) return null;
    const expected = sign(encoded, key);
    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (bookingId && payload.bid !== String(bookingId).trim()) return null;
    if (email && payload.emh !== digestEmail(email)) return null;
    if (
      targetPackageTitle &&
      payload.pkg !== normalizePackageTitle(targetPackageTitle)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
};
