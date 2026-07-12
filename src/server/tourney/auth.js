import crypto from "crypto";
import bcrypt from "bcryptjs";
import { readPersistedTourneyAccountsJson } from "./accountStore";
import {
  findTourneyPlayerForSession,
  verifyTourneyPlayerCredentials,
} from "./playerStore";
import { getClientAddressFromFetchHeaders } from "../request/clientAddress";
import { requireRateLimit } from "../api/ref/rateLimit";
import { authenticateSupabaseAccount, resolveSupabaseAccountAlias } from "../supabase/accounts";
import {
  resolveSupabaseRuntimePolicy,
  shouldUseSupabaseForAccount,
} from "../supabase/runtime";
import { isSupabaseAdminConfigured } from "../supabase/adminClient";

export const TOURNEY_SESSION_COOKIE = "tourney_session";
export const TOURNEY_ADMIN_ROLES = Object.freeze(["viewer", "caster", "owner"]);
export const TOURNEY_ROLES = Object.freeze([...TOURNEY_ADMIN_ROLES, "player"]);
export const TOURNEY_OWNER_MANAGED_ROLES = Object.freeze(["viewer", "caster"]);

export const TOURNEY_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
export const TOURNEY_REMEMBERED_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_MAX_AGE_SECONDS = TOURNEY_SESSION_MAX_AGE_SECONDS;
const PASSWORD_RESET_MAX_AGE_SECONDS = 60 * 60;
const DUMMY_PASSWORD_HASH =
  // nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash
  "$2b$10$t6/bHTKT3hABxzcK8HIMauYsrY88CioIiiq0Cwci4RPXbOq30kAWy";

const base64UrlEncode = (value) =>
  Buffer.from(value).toString("base64url");

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

const getSessionSecret = (env = process.env) => {
  const configured = String(env.TOURNEY_SESSION_SECRET || "").trim();
  if (configured) return configured;
  return env.NODE_ENV === "production" ? "" : "dev_tourney_session_secret";
};

const normalizeUsername = (value) =>
  String(value || "").trim().toLowerCase();

export const normalizeTourneyEmail = (value) =>
  String(value || "").trim().toLowerCase();

const normalizeAdminRole = (value) => {
  const role = String(value || "").trim().toLowerCase();
  return TOURNEY_ADMIN_ROLES.includes(role) ? role : "";
};

const normalizeRole = (value) => {
  const role = String(value || "").trim().toLowerCase();
  return TOURNEY_ROLES.includes(role) ? role : "";
};

const nextVersion = (value) => {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return String(Date.now());
  return String(numeric + 1);
};

const normalizeAccount = (account) => {
  const username = normalizeUsername(account?.username);
  const role = normalizeAdminRole(account?.role);
  const email = normalizeTourneyEmail(account?.email);
  const passwordHash = String(account?.passwordHash || account?.password_hash || "").trim();
  const version = String(account?.version || "1").trim() || "1";

  if (!username || !role || !passwordHash) return null;

  return {
    username,
    ...(email ? { email } : {}),
    role,
    passwordHash,
    active: account?.active !== false,
    version,
  };
};

export const parseTourneyAccounts = (raw = "") => {
  if (!String(raw || "").trim()) return [];

  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : parsed?.accounts;
    if (!Array.isArray(rows)) return [];
    return rows.map(normalizeAccount).filter(Boolean);
  } catch {
    return [];
  }
};

export const readTourneyAccounts = (env = process.env) =>
  parseTourneyAccounts(env.TOURNEY_ACCOUNTS_JSON || "");

export const readBootstrapTourneyAccounts = (env = process.env) =>
  parseTourneyAccounts(env.TOURNEY_BOOTSTRAP_ACCOUNTS_JSON || "");

const mergeTourneyAccounts = (...accountLists) => {
  const merged = new Map();

  for (const accounts of accountLists) {
    for (const account of accounts || []) {
      const normalized = normalizeAccount(account);
      if (normalized) {
        merged.set(normalized.username, normalized);
      }
    }
  }

  return [...merged.values()].sort((left, right) =>
    left.username.localeCompare(right.username)
  );
};

export const readEffectiveTourneyAccounts = async ({
  env = process.env,
  readPersistedAccountsJson = readPersistedTourneyAccountsJson,
} = {}) => {
  const persistedRaw = await readPersistedAccountsJson(env);
  const persistedAccounts = parseTourneyAccounts(persistedRaw);
  return mergeTourneyAccounts(
    readTourneyAccounts(env),
    readBootstrapTourneyAccounts(env),
    persistedAccounts
  );
};

export const summarizeTourneyAccount = (account) => ({
  username: account.username,
  email: account.email || "",
  role: account.role,
  active: account.active,
  version: account.version,
});

export const summarizeTourneyAccounts = (accounts = readTourneyAccounts()) =>
  accounts
    .map(summarizeTourneyAccount)
    .sort((left, right) => left.username.localeCompare(right.username));

export const renderTourneyAccountsJson = (accounts = readTourneyAccounts()) =>
  JSON.stringify(
    accounts
      .map(normalizeAccount)
      .filter(Boolean)
      .sort((left, right) => left.username.localeCompare(right.username)),
    null,
    2
  );

export const findTourneyAccount = (username, accounts = readTourneyAccounts()) => {
  const normalizedUsername = normalizeUsername(username);
  return accounts.find((account) => account.username === normalizedUsername) || null;
};

export const findTourneyAccountByEmail = (
  email,
  accounts = readTourneyAccounts()
) => {
  const normalizedEmail = normalizeTourneyEmail(email);
  if (!normalizedEmail) return null;
  return accounts.find((account) => normalizeTourneyEmail(account.email) === normalizedEmail) || null;
};

export const getTourneyAdminEmail = (account, env = process.env) => {
  const email = normalizeTourneyEmail(account?.email);
  if (email) return email;

  const ownerEmail = normalizeTourneyEmail(
    env.TOURNEY_OWNER_EMAIL || "serviroo@rooindustries.com"
  );
  if (account?.role === "owner" && account?.username === "serviroo") {
    return ownerEmail;
  }

  if (account?.role === "caster" && account?.username === "yukari") {
    return "yukariipoi@gmail.com";
  }

  return "";
};

export const getTourneyApprovalRecipients = async ({
  env = process.env,
  readPersistedAccountsJson = readPersistedTourneyAccountsJson,
} = {}) => {
  const configuredEmails = String(
    env.TOURNEY_APPROVAL_EMAILS ||
      `${env.TOURNEY_OWNER_EMAIL || "serviroo@rooindustries.com"},yukariipoi@gmail.com`
  )
    .split(",")
    .map(normalizeTourneyEmail)
    .filter(Boolean);
  const allowedEmails = new Set(configuredEmails);
  const accounts = await readEffectiveTourneyAccounts({
    env,
    readPersistedAccountsJson,
  });

  return accounts
    .filter((account) => account.active && ["owner", "caster"].includes(account.role))
    .map((account) => ({
      username: account.username,
      role: account.role,
      version: account.version,
      email: getTourneyAdminEmail(account, env),
    }))
    .filter((account) => account.email && allowedEmails.has(account.email));
};

export const findActiveTourneyApprover = async ({
  username,
  email,
  version,
  env = process.env,
  readPersistedAccountsJson = readPersistedTourneyAccountsJson,
} = {}) => {
  const accounts = await readEffectiveTourneyAccounts({
    env,
    readPersistedAccountsJson,
  });
  const normalizedUsername = normalizeUsername(username);
  const normalizedEmail = normalizeTourneyEmail(email);
  const account = accounts.find((candidate) => {
    if (!candidate.active || !["owner", "caster"].includes(candidate.role)) {
      return false;
    }
    const candidateEmail = getTourneyAdminEmail(candidate, env);
    return (
      candidate.username === normalizedUsername &&
      candidateEmail === normalizedEmail &&
      String(candidate.version || "1") === String(version || "1")
    );
  });

  return account || null;
};

export const checkTourneyRateLimit = async ({
  key,
  max = 10,
  windowMs = 15 * 60 * 1000,
  now = Date.now(),
} = {}) => {
  const responseState = { status: 200, body: null, headers: new Map() };
  const res = {
    setHeader(name, value) {
      responseState.headers.set(String(name || "").toLowerCase(), String(value));
      return this;
    },
    status(status) {
      responseState.status = Number(status) || 500;
      return this;
    },
    json(body) {
      responseState.body = body;
      return this;
    },
  };
  const ok = await requireRateLimit(res, {
    key: `tourney:${String(key || "unknown")}`,
    max,
    windowMs,
    now,
    failClosed: true,
  });
  if (ok) return { ok: true, status: 200, retryAfterSeconds: 0 };
  return {
    ok: false,
    status: responseState.status,
    error: responseState.body?.error || "Request protection is temporarily unavailable.",
    retryAfterSeconds: Number(responseState.headers.get("retry-after") || 30),
  };
};

export const isTourneyAuthConfigured = (env = process.env) =>
  Boolean(
    getSessionSecret(env) &&
      (readTourneyAccounts(env).length > 0 ||
        (resolveSupabaseRuntimePolicy(env).primaryBackend === "supabase" &&
          isSupabaseAdminConfigured(env)))
  );

export const verifyTourneyCredentials = async ({
  username,
  password,
  env = process.env,
  readPersistedAccountsJson = readPersistedTourneyAccountsJson,
} = {}) => {
  if (shouldUseSupabaseForAccount({ identifier: username, env })) {
    const result = await authenticateSupabaseAccount({
      identifier: username,
      password,
      env,
      requiredRoles: [
        "tourney_player",
        "tourney_viewer",
        "tourney_caster",
        "tourney_owner",
      ],
      accountScope: "tourney",
    });
    if (!result.ok) return result;
    const role = String(result.account.tourney_role || "").replace(/^tourney_/, "");
    if (!TOURNEY_ROLES.includes(role) || !result.account.tourney_username) {
      return { ok: false, account: null, reason: "invalid_credentials" };
    }
    return {
      ok: true,
      supabaseSession: result.session,
      account: {
        username: result.account.tourney_username,
        role,
        active: result.account.tourney_active !== false,
        version: String(result.account.credential_version || "1"),
        authBackend: "supabase",
      },
    };
  }

  const accounts = await readEffectiveTourneyAccounts({
    env,
    readPersistedAccountsJson,
  });
  const login = normalizeUsername(username);
  const account =
    findTourneyAccount(login, accounts) || findTourneyAccountByEmail(login, accounts);
  const candidateHash = account?.active ? account.passwordHash : DUMMY_PASSWORD_HASH;
  const passwordMatches = await bcrypt.compare(String(password || ""), candidateHash);

  const bridgeSession = async () => {
    if (!isSupabaseAdminConfigured(env)) return null;
    try {
      const bridge = await authenticateSupabaseAccount({
        identifier: login,
        password,
        env,
        requiredRoles: [
          "tourney_player",
          "tourney_viewer",
          "tourney_caster",
          "tourney_owner",
        ],
        accountScope: "tourney",
      });
      return bridge.ok ? bridge.session : null;
    } catch {
      return null;
    }
  };

  if (getSessionSecret(env) && account?.active && passwordMatches) {
    return { ok: true, account, supabaseSession: await bridgeSession() };
  }

  const playerResult = await verifyTourneyPlayerCredentials({
    login: username,
    password,
    env,
  });
  if (getSessionSecret(env) && playerResult.ok) {
    return {
      ok: true,
      account: playerResult.account,
      supabaseSession: await bridgeSession(),
    };
  }

  return {
    ok: false,
    account: null,
    reason: playerResult.reason || "",
  };
};

export const buildUpdatedTourneyAccounts = async ({
  action,
  username,
  actorUsername,
  role,
  email,
  password,
  accounts = readTourneyAccounts(),
} = {}) => {
  const normalizedAction = String(action || "").trim().toLowerCase();
  const normalizedUsername = normalizeUsername(username);
  const normalizedActorUsername = normalizeUsername(actorUsername);
  const normalizedRole = normalizeAdminRole(role);
  const normalizedEmail = normalizeTourneyEmail(email);

  if (!normalizedUsername) {
    throw new Error("Missing username.");
  }

  if (normalizedAction === "upsert") {
    if (!TOURNEY_OWNER_MANAGED_ROLES.includes(normalizedRole)) {
      throw new Error("Owner-managed accounts must be viewer or caster.");
    }

    const plainPassword = String(password || "");
    if (plainPassword.length < 8) {
      throw new Error("Passwords must be at least 8 characters.");
    }

    const existingIndex = accounts.findIndex(
      (account) => account.username === normalizedUsername
    );
    const existing = existingIndex >= 0 ? accounts[existingIndex] : null;
    if (existing?.role === "owner") {
      throw new Error("Owner accounts can only be changed from server env.");
    }

    const passwordHash = await bcrypt.hash(plainPassword, 12);
    const nextAccount = {
      username: normalizedUsername,
      ...(normalizedEmail || existing?.email
        ? { email: normalizedEmail || existing.email }
        : {}),
      role: normalizedRole,
      passwordHash,
      active: true,
      version: nextVersion(existing?.version || "0"),
    };

    if (existingIndex >= 0) {
      return accounts.map((account, index) =>
        index === existingIndex ? nextAccount : account
      );
    }

    return [...accounts, nextAccount];
  }

  if (normalizedAction === "change-password") {
    const existingIndex = accounts.findIndex(
      (account) => account.username === normalizedUsername
    );
    const existing = existingIndex >= 0 ? accounts[existingIndex] : null;
    if (!existing) {
      throw new Error("Account not found.");
    }
    if (
      existing.role === "owner" &&
      existing.username !== normalizedActorUsername
    ) {
      throw new Error("Owner accounts can only change their own password.");
    }

    const plainPassword = String(password || "");
    if (plainPassword.length < 8) {
      throw new Error("Passwords must be at least 8 characters.");
    }

    const passwordHash = await bcrypt.hash(plainPassword, 12);
    return accounts.map((account, index) =>
      index === existingIndex
        ? {
            ...account,
            passwordHash,
            version: nextVersion(account.version),
          }
        : account
    );
  }

  if (normalizedAction === "disable") {
    const existing = accounts.find((account) => account.username === normalizedUsername);
    if (!existing) {
      throw new Error("Account not found.");
    }
    if (existing.role === "owner") {
      throw new Error("Owner accounts can only be changed from server env.");
    }

    return accounts.map((account) =>
      account.username === normalizedUsername
        ? {
            ...account,
            active: false,
            version: nextVersion(account.version),
          }
        : account
    );
  }

  throw new Error("Unsupported account action.");
};

export const createTourneySessionToken = ({
  account,
  env = process.env,
  maxAgeSeconds = SESSION_MAX_AGE_SECONDS,
} = {}) => {
  const secret = getSessionSecret(env);
  if (!secret || !account?.username || !account?.role) return "";

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    p: "session",
    sub: account.username,
    role: account.role,
    av: String(account.version || "1"),
    ab: account.authBackend === "supabase" ? "supabase" : "sanity",
    iat: now,
    exp: now + maxAgeSeconds,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
};

export const createTourneyPasswordResetToken = ({
  account,
  env = process.env,
  maxAgeSeconds = PASSWORD_RESET_MAX_AGE_SECONDS,
} = {}) => {
  const secret = getSessionSecret(env);
  if (!secret || !account?.username || !account?.role) return "";

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    p: "password-reset",
    sub: account.username,
    role: account.role,
    av: String(account.version || "1"),
    iat: now,
    exp: now + maxAgeSeconds,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
};

export const readTourneySessionPayload = ({
  token,
  env = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
  purpose = "session",
} = {}) => {
  try {
    const secret = getSessionSecret(env);
    if (!secret || !token || typeof token !== "string") return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encodedPayload, signature] = parts;
    if (!encodedPayload || !signature) return null;

    const expected = sign(encodedPayload, secret);
    if (!timingSafeEqualString(signature, expected)) return null;

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (String(payload?.p || "session") !== purpose) return null;
    const username = normalizeUsername(payload?.sub);
    const role = normalizeRole(payload?.role);
    if (!username || !role || !payload?.exp || payload.exp <= nowSeconds) {
      return null;
    }

    return {
      username,
      role,
      accountVersion: String(payload.av || "1"),
      authBackend: payload.ab === "supabase" ? "supabase" : "sanity",
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
};

export const readTourneyPasswordReset = ({
  token,
  env = process.env,
  accounts,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) => {
  const payload = readTourneySessionPayload({
    token,
    env,
    nowSeconds,
    purpose: "password-reset",
  });
  if (!payload || payload.role === "player") return null;

  const account = findTourneyAccount(
    payload.username,
    Array.isArray(accounts) ? accounts : readTourneyAccounts(env)
  );
  if (
    !account ||
    !account.active ||
    account.role !== payload.role ||
    String(account.version || "1") !== payload.accountVersion
  ) {
    return null;
  }

  return account;
};

export const readTourneySession = ({
  token,
  env = process.env,
  accounts,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) => {
  try {
    const payload = readTourneySessionPayload({ token, env, nowSeconds });
    if (!payload || payload.role === "player") return null;

    const account = findTourneyAccount(
      payload.username,
      Array.isArray(accounts) ? accounts : readTourneyAccounts(env)
    );
    if (
      !account ||
      !account.active ||
      account.role !== payload.role ||
      String(account.version || "1") !== payload.accountVersion
    ) {
      return null;
    }

    return {
      username: account.username,
      role: account.role,
      expiresAt: payload.expiresAt,
    };
  } catch {
    return null;
  }
};

export const readTourneySessionFromStore = async ({
  token,
  env = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
  readPersistedAccountsJson = readPersistedTourneyAccountsJson,
} = {}) => {
  const payload = readTourneySessionPayload({ token, env, nowSeconds });
  if (!payload) return null;

  if (payload.authBackend === "supabase") {
    const account = await resolveSupabaseAccountAlias({
      identifier: payload.username,
      accountScope: "tourney",
    });
    const role = String(account?.tourney_role || "").replace(/^tourney_/, "");
    if (
      !account ||
      account.status !== "active" ||
      account.tourney_active === false ||
      account.tourney_username !== payload.username ||
      role !== payload.role ||
      String(account.credential_version || "1") !== payload.accountVersion
    ) {
      return null;
    }
    return {
      username: account.tourney_username,
      role,
      ...(role === "player" && account.legacy_sanity_id
        ? { playerId: account.legacy_sanity_id }
        : {}),
      authBackend: "supabase",
      expiresAt: payload.expiresAt,
    };
  }

  if (payload.role === "player") {
    const player = await findTourneyPlayerForSession({
      username: payload.username,
      version: payload.accountVersion,
      env,
    });
    if (!player) return null;

    return {
      username: player.username,
      role: "player",
      playerId: player.id,
      authBackend: "sanity",
      expiresAt: payload.expiresAt,
    };
  }

  const accounts = await readEffectiveTourneyAccounts({
    env,
    readPersistedAccountsJson,
  });
  const session = readTourneySession({
    token,
    env,
    accounts,
    nowSeconds,
  });
  return session ? { ...session, authBackend: "sanity" } : null;
};

const shouldUseSecureCookie = (env = process.env) =>
  env.TOURNEY_ALLOW_INSECURE_COOKIE === "1" ? false : env.NODE_ENV === "production";

export const getTourneyCookieOptions = (
  env = process.env,
  { maxAgeSeconds = SESSION_MAX_AGE_SECONDS } = {}
) => ({
  httpOnly: true,
  sameSite: "lax",
  secure: shouldUseSecureCookie(env),
  path: "/",
  maxAge: maxAgeSeconds,
});

export const getClearTourneyCookieOptions = (env = process.env) => ({
  httpOnly: true,
  sameSite: "lax",
  secure: shouldUseSecureCookie(env),
  path: "/",
  maxAge: 0,
});

export const getClientAddressFromHeaders = (headers) => {
  return getClientAddressFromFetchHeaders(headers);
};
