import crypto from "crypto";

const secret = () =>
  String(
    process.env.UPGRADE_INTENT_SECRET ||
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
  backend = "sanity",
  cutoverGeneration = 0,
  expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(),
}) => {
  const key = secret();
  if (!key) throw new Error("UPGRADE_INTENT_SECRET is required.");
  const normalizedBookingId = String(bookingId || "").trim();
  const normalizedEmail = normalize(email);
  const normalizedPackage = normalizePackageTitle(targetPackageTitle);
  if (!normalizedBookingId || !normalizedEmail || !normalizedPackage) {
    throw new Error("Upgrade intent is incomplete.");
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    v: 2,
    bid: normalizedBookingId,
    emh: digestEmail(normalizedEmail),
    pkg: normalizedPackage,
    iat: issuedAt,
    exp: Math.floor(new Date(expiresAt).getTime() / 1000),
    n: crypto.randomUUID(),
    be: backend === "supabase" ? "supabase" : "sanity",
    gen: Math.max(0, Number(cutoverGeneration) || 0),
  };
  if (!Number.isFinite(payload.exp) || payload.exp <= issuedAt) {
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
  backend = "",
  cutoverGeneration,
}) => {
  try {
    const key = secret();
    const normalizedBookingId = String(bookingId || "").trim();
    const normalizedEmail = normalize(email);
    const normalizedPackage = normalizePackageTitle(targetPackageTitle);
    if (
      !key ||
      typeof token !== "string" ||
      !normalizedBookingId ||
      !normalizedEmail ||
      !normalizedPackage
    ) {
      return null;
    }
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encoded, signature] = parts;
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
    if (payload.bid !== normalizedBookingId) return null;
    if (payload.emh !== digestEmail(normalizedEmail)) return null;
    if (payload.pkg !== normalizedPackage) return null;
    if (backend && (payload.be === "supabase" ? "supabase" : "sanity") !== backend) {
      return null;
    }
    if (
      cutoverGeneration !== undefined &&
      payload.gen !== undefined &&
      Number(payload.gen) !== Math.max(0, Number(cutoverGeneration) || 0)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
};

export const freezeUpgradeIntent = ({ payload, verifiedAt = new Date().toISOString() }) => {
  if (!payload?.bid || !payload?.emh || !payload?.pkg || !Number.isFinite(payload?.exp)) {
    return null;
  }
  return {
    intentId: String(payload.n || "").trim(),
    bookingId: String(payload.bid).trim(),
    emailHash: String(payload.emh).trim(),
    targetPackage: String(payload.pkg).trim(),
    backend: payload.be === "supabase" ? "supabase" : "sanity",
    cutoverGeneration: Math.max(0, Number(payload.gen) || 0),
    tokenIssuedAt: Number(payload.iat || 0)
      ? new Date(Number(payload.iat) * 1000).toISOString()
      : "",
    tokenExpiresAt: new Date(Number(payload.exp) * 1000).toISOString(),
    verifiedAt: new Date(verifiedAt).toISOString(),
  };
};

export const verifyFrozenUpgradeIntent = ({
  snapshot,
  bookingId,
  email,
  targetPackageTitle,
}) => {
  const normalizedBookingId = String(bookingId || "").trim();
  const normalizedEmail = normalize(email);
  const normalizedPackage = normalizePackageTitle(targetPackageTitle);
  if (
    !snapshot ||
    !normalizedBookingId ||
    !normalizedEmail ||
    !normalizedPackage
  ) {
    return false;
  }
  const verifiedAt = new Date(snapshot.verifiedAt || "").getTime();
  const expiresAt = new Date(snapshot.tokenExpiresAt || "").getTime();
  return (
    Number.isFinite(verifiedAt) &&
    Number.isFinite(expiresAt) &&
    verifiedAt <= expiresAt &&
    String(snapshot.bookingId || "").trim() === normalizedBookingId &&
    String(snapshot.emailHash || "").trim() === digestEmail(normalizedEmail) &&
    String(snapshot.targetPackage || "").trim() === normalizedPackage
  );
};
