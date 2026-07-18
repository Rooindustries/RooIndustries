import crypto from "node:crypto";
import envValue from "./envValue.cjs";

const { readEnvValue } = envValue;
const MAX_LEASE_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 30;

const fail = (message, code = "COMMERCE_FAILOVER_LEASE_INVALID") => {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  error.statusCode = 503;
  return error;
};

const requireSecret = (secret) => {
  const value = String(secret || "");
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw fail("The commerce failover lease secret is invalid.");
  }
  return value;
};

const normalizeDeploymentId = (value) => {
  const deploymentId = String(value || "").trim();
  if (
    !deploymentId ||
    deploymentId.length > 200 ||
    /[\x00-\x1f\x7f]/.test(deploymentId)
  ) {
    throw fail("The commerce deployment identity is invalid.");
  }
  return deploymentId;
};

export const resolveCommerceDeploymentId = (env = process.env) =>
  normalizeDeploymentId(
    readEnvValue(env, "COMMERCE_DEPLOYMENT_ID") ||
      readEnvValue(env, "VERCEL_DEPLOYMENT_ID") ||
      readEnvValue(env, "VERCEL_GIT_COMMIT_SHA")
  );

const sign = ({ encodedPayload, secret }) =>
  crypto.createHmac("sha256", secret).update(encodedPayload).digest();

const normalizeClaims = ({ payload, nowSeconds }) => {
  const generation = Number(payload?.generation);
  const issuedAt = Number(payload?.issuedAt);
  const expiresAt = Number(payload?.expiresAt);
  if (
    payload?.version !== 1 ||
    !["sanity", "supabase"].includes(payload?.backend) ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    typeof payload?.pause !== "boolean" ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_LEASE_SECONDS ||
    issuedAt > nowSeconds + CLOCK_SKEW_SECONDS ||
    expiresAt <= nowSeconds
  ) {
    throw fail("The commerce failover lease claims are invalid or expired.");
  }
  return {
    backend: payload.backend,
    generation,
    startsPaused: payload.pause,
    deploymentId: normalizeDeploymentId(payload.deploymentId),
    issuedAt,
    expiresAt,
  };
};

export const issueCommerceFailoverLease = ({
  backend,
  generation,
  startsPaused,
  deploymentId,
  secret,
  issuedAt = Math.floor(Date.now() / 1000),
  expiresAt = issuedAt + 5 * 60,
} = {}) => {
  const normalizedBackend = String(backend || "").trim().toLowerCase();
  if (!["sanity", "supabase"].includes(normalizedBackend)) {
    throw fail("The commerce failover lease backend is invalid.");
  }
  const payload = {
    version: 1,
    backend: normalizedBackend,
    generation: Number(generation),
    pause: startsPaused,
    deploymentId: normalizeDeploymentId(deploymentId),
    issuedAt: Number(issuedAt),
    expiresAt: Number(expiresAt),
  };
  normalizeClaims({ payload, nowSeconds: Number(issuedAt) });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign({ encodedPayload, secret: requireSecret(secret) });
  return `${encodedPayload}.${signature.toString("base64url")}`;
};

export const verifyCommerceFailoverLease = ({
  token,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) => {
  const normalizedToken = String(token || "").trim();
  if (
    normalizedToken.length > 4096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(normalizedToken)
  ) {
    throw fail("The commerce failover lease is malformed.");
  }
  const [encodedPayload, encodedSignature] = normalizedToken.split(".");
  const expected = sign({ encodedPayload, secret: requireSecret(secret) });
  const provided = Buffer.from(encodedSignature, "base64url");
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    throw fail("The commerce failover lease signature is invalid.");
  }

  let payload;
  try {
    const decoded = Buffer.from(encodedPayload, "base64url");
    if (decoded.length > 2048) throw new Error("oversized");
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw fail("The commerce failover lease payload is invalid.");
  }
  return normalizeClaims({ payload, nowSeconds: Number(nowSeconds) });
};

export const requireCommerceFailoverLease = ({
  env = process.env,
  policy,
  nowSeconds,
} = {}) => {
  const lease = verifyCommerceFailoverLease({
    token: readEnvValue(env, "COMMERCE_FAILOVER_LEASE"),
    secret: readEnvValue(env, "COMMERCE_FAILOVER_LEASE_SECRET"),
    ...(nowSeconds === undefined ? {} : { nowSeconds }),
  });
  const deploymentId = resolveCommerceDeploymentId(env);
  if (
    lease.backend !== policy?.commercePrimaryBackend ||
    lease.generation !== policy?.commerceFailoverGeneration ||
    lease.startsPaused !== policy?.commerceStartsPaused ||
    lease.deploymentId !== deploymentId
  ) {
    throw fail(
      "The commerce failover lease does not match this deployment.",
      "COMMERCE_FAILOVER_LEASE_MISMATCH"
    );
  }
  return lease;
};

export const assertCommerceControlMatchesLease = ({ control, lease } = {}) => {
  if (
    control?.primaryBackend !== lease?.backend ||
    control?.generation !== lease?.generation ||
    control?.startsPaused !== lease?.startsPaused
  ) {
    throw fail(
      "The live commerce control plane does not match the failover lease.",
      "COMMERCE_FAILOVER_LEASE_MISMATCH"
    );
  }
};

export const COMMERCE_FAILOVER_LEASE_MAX_AGE_SECONDS = MAX_LEASE_SECONDS;
