#!/usr/bin/env node
import bcrypt from "bcryptjs";

const VALID_ROLES = new Set(["viewer", "caster", "owner"]);

const normalizeUsername = (value) =>
  String(value || "").trim().toLowerCase();

const normalizeEmail = (value) =>
  String(value || "").trim().toLowerCase();

const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  const flags = {};

  for (let index = 0; index < rest.length; index += 1) {
    const entry = rest[index];
    if (!entry.startsWith("--")) continue;

    const key = entry.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { command, flags };
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
};

const readAccounts = (raw) => {
  const source = String(raw || process.env.TOURNEY_ACCOUNTS_JSON || "").trim();
  if (!source) return [];

  const parsed = JSON.parse(source);
  const rows = Array.isArray(parsed) ? parsed : parsed?.accounts;
  if (!Array.isArray(rows)) {
    throw new Error("TOURNEY_ACCOUNTS_JSON must be an array or { accounts: [] }.");
  }

  return rows.map((account) => ({
    username: normalizeUsername(account.username),
    email: normalizeEmail(account.email),
    role: String(account.role || "").trim().toLowerCase(),
    passwordHash: String(account.passwordHash || account.password_hash || "").trim(),
    active: account.active !== false,
    version: String(account.version || "1").trim() || "1",
  }));
};

const renderAccountsJson = (accounts) =>
  JSON.stringify(
    accounts
      .filter((account) => account.username && VALID_ROLES.has(account.role))
      .sort((left, right) => left.username.localeCompare(right.username)),
    null,
    2
  );

const nextVersion = (value) => {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return String(Date.now());
  return String(numeric + 1);
};

const getPassword = async (flags) => {
  if (flags["password-stdin"]) {
    const value = await readStdin();
    if (value) return value;
  }

  const value = String(flags.password || "").trim();
  if (value) return value;
  throw new Error("Provide --password or --password-stdin for upsert.");
};

const upsertAccount = async (accounts, flags) => {
  const username = normalizeUsername(flags.username);
  const role = String(flags.role || "").trim().toLowerCase();

  if (!username) throw new Error("Missing --username.");
  if (!VALID_ROLES.has(role)) {
    throw new Error("--role must be viewer, caster, or owner.");
  }

  const existingIndex = accounts.findIndex((account) => account.username === username);
  const existing = existingIndex >= 0 ? accounts[existingIndex] : null;
  const password = await getPassword(flags);
  const passwordHash = await bcrypt.hash(password, 12);
  const account = {
    username,
    ...(normalizeEmail(flags.email) || existing?.email
      ? { email: normalizeEmail(flags.email) || existing.email }
      : {}),
    role,
    passwordHash,
    active: true,
    version: nextVersion(existing?.version || "0"),
  };

  if (existingIndex >= 0) {
    accounts[existingIndex] = account;
    return accounts;
  }

  return [...accounts, account];
};

const disableAccount = (accounts, flags) => {
  const username = normalizeUsername(flags.username);
  if (!username) throw new Error("Missing --username.");

  return accounts.map((account) =>
    account.username === username
      ? {
          ...account,
          active: false,
          version: nextVersion(account.version),
        }
      : account
  );
};

const changePassword = async (accounts, flags) => {
  const username = normalizeUsername(flags.username);
  if (!username) throw new Error("Missing --username.");

  const existingIndex = accounts.findIndex((account) => account.username === username);
  if (existingIndex < 0) {
    throw new Error("Account not found.");
  }

  const password = await getPassword(flags);
  const passwordHash = await bcrypt.hash(password, 12);
  return accounts.map((account, index) =>
    index === existingIndex
      ? {
          ...account,
          passwordHash,
          version: nextVersion(account.version),
        }
      : account
  );
};

const listAccounts = (accounts) => {
  const rows = accounts
    .sort((left, right) => left.username.localeCompare(right.username))
    .map((account) => ({
      username: account.username,
      email: account.email || "",
      role: account.role,
      active: account.active,
      version: account.version,
      hasPasswordHash: Boolean(account.passwordHash),
    }));
  console.log(JSON.stringify(rows, null, 2));
};

const printUsage = () => {
  console.error(
    [
      "Usage:",
      "  TOURNEY_ACCOUNTS_JSON='[...]' node scripts/tourney-accounts.mjs list",
      "  node scripts/tourney-accounts.mjs upsert --username owner1 --role owner --password-stdin",
      "  node scripts/tourney-accounts.mjs upsert --username caster1 --email caster@example.com --role caster --password-stdin",
      "  TOURNEY_ACCOUNTS_JSON='[...]' node scripts/tourney-accounts.mjs password --username caster1 --password-stdin",
      "  TOURNEY_ACCOUNTS_JSON='[...]' node scripts/tourney-accounts.mjs disable --username viewer1",
      "",
      "Outputs updated JSON for TOURNEY_ACCOUNTS_JSON. Passwords are never printed.",
    ].join("\n")
  );
};

const main = async () => {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const accounts = readAccounts(flags.accounts || flags["accounts-json"]);

  if (command === "list") {
    listAccounts(accounts);
    return;
  }

  if (command === "upsert") {
    console.log(renderAccountsJson(await upsertAccount(accounts, flags)));
    return;
  }

  if (command === "password" || command === "change-password") {
    console.log(renderAccountsJson(await changePassword(accounts, flags)));
    return;
  }

  if (command === "disable") {
    console.log(renderAccountsJson(disableAccount(accounts, flags)));
    return;
  }

  printUsage();
  process.exit(1);
};

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
