import crypto from "crypto";
import bcrypt from "bcryptjs";
import { extractTwitchLogin, normalizeTwitchUsername } from "./twitch";

export const TOURNEY_PLAYER_STATUSES = Object.freeze([
  "pending",
  "approved",
  "denied",
  "removed",
]);
export const TOURNEY_RANKS = Object.freeze([
  "Master",
  "Grandmaster",
  "Champion",
]);
export const TOURNEY_ROLE_PLAYS = Object.freeze([
  "Tank",
  "Damage",
  "Support",
  "Flex",
]);
export const TOURNEY_TIMEZONES = Object.freeze([
  "Pacific Time (PT)",
  "Mountain Time (MT)",
  "Central Time (CT)",
  "Eastern Time (ET)",
  "Atlantic Time (AT)",
  "Alaska Time (AKT)",
  "Hawaii Time (HT)",
  "UTC / GMT",
  "UK / Ireland (BST/GMT)",
  "Central Europe (CET/CEST)",
  "Eastern Europe (EET/EEST)",
  "Turkey (TRT)",
  "Gulf Standard Time (GST)",
  "India Standard Time (IST)",
  "SE Asia (ICT/WIB)",
  "Singapore / China (SGT/CST)",
  "Japan / Korea (JST/KST)",
  "Australian Western (AWST)",
  "Australian Eastern (AEST/AEDT)",
  "New Zealand (NZST/NZDT)",
  "Brazil (BRT)",
  "Argentina (ART)",
  "Other / not listed",
]);

const TOKEN_BYTES = 32;
const APPROVAL_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TOKEN_MAX_AGE_MS = 60 * 60 * 1000;
const DUMMY_PLAYER_HASH =
  "$2b$10$t6/bHTKT3hABxzcK8HIMauYsrY88CioIiiq0Cwci4RPXbOq30kAWy";

const MEMORY_STORE =
  globalThis.__rooTourneyPlayerStore ||
  (globalThis.__rooTourneyPlayerStore = {
    players: [],
    tokens: [],
  });
const SQL_CLIENTS =
  globalThis.__rooTourneySqlClients ||
  (globalThis.__rooTourneySqlClients = new Map());
let schemaReady = false;

export const normalizeTourneyUsername = (value) =>
  String(value || "").trim().toLowerCase();

export const normalizeTourneyEmail = (value) =>
  String(value || "").trim().toLowerCase();

export const normalizeDiscordKey = (value) =>
  String(value || "").trim().toLowerCase().replace(/\s+/g, "");

const normalizeText = (value) => String(value || "").trim();
const USERNAME_PATTERN = /^[a-z0-9_.-]{3,24}$/;

const nowIso = () => new Date().toISOString();

const tokenHash = (token) =>
  crypto.createHash("sha256").update(String(token || "")).digest("hex");

const compactInternalUsernameBase = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/[-_.]{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");

const buildInternalTourneyUsername = (discord) => {
  const discordKey = normalizeDiscordKey(discord);
  const hash = crypto
    .createHash("sha256")
    .update(discordKey || normalizeText(discord))
    .digest("hex")
    .slice(0, 8);
  const base = compactInternalUsernameBase(discordKey) || "player";
  const paddedBase = base.length >= 3 ? base : `player-${base}`;
  const maxBaseLength = 24 - hash.length - 1;
  const trimmedBase =
    paddedBase.slice(0, maxBaseLength).replace(/[-_.]+$/g, "") || "player";
  return `${trimmedBase}-${hash}`;
};

export const createPlainToken = () =>
  crypto.randomBytes(TOKEN_BYTES).toString("base64url");

const isMemoryMode = (env = process.env) =>
  env.TOURNEY_PLAYER_STORE_MODE === "memory" ||
  env.TOURNEY_DATABASE_MODE === "memory";

const getDatabaseUrl = (env = process.env) =>
  String(env.TOURNEY_DATABASE_URL || env.POSTGRES_URL || "").trim();

const getSql = async (env = process.env) => {
  const databaseUrl = getDatabaseUrl(env);
  if (!databaseUrl) {
    throw new Error("TOURNEY_DATABASE_URL is not configured.");
  }

  if (!SQL_CLIENTS.has(databaseUrl)) {
    const { neon } = await import("@neondatabase/serverless");
    SQL_CLIENTS.set(databaseUrl, neon(databaseUrl));
  }

  return SQL_CLIENTS.get(databaseUrl);
};

export const hashTourneyToken = tokenHash;

export const resetMemoryTourneyPlayerStoreForTests = () => {
  MEMORY_STORE.players = [];
  MEMORY_STORE.tokens = [];
};

const mapPlayer = (row = {}) => ({
  id: row.id,
  username: row.username,
  email: row.email,
  status: row.status,
  discord: row.discord,
  displayName: row.display_name || row.displayName || row.discord || "",
  discordKey: row.discord_key || row.discordKey,
  battlenet: row.battlenet,
  rank: row.rank_name || row.rank,
  rolePlay: row.role_play || row.rolePlay,
  timezone: row.time_zone || row.timezone || "",
  twitchUsername: extractTwitchLogin(row.twitch_username || row.twitchUsername),
  teamName: row.team_name || row.teamName || "",
  availableAug12: Boolean(row.available_aug_1_2 ?? row.availableAug12),
  notes: row.notes || "",
  version: String(row.version || "1"),
  createdAt: row.created_at || row.createdAt || "",
  updatedAt: row.updated_at || row.updatedAt || "",
  approvedAt: row.approved_at || row.approvedAt || "",
  approvedBy: row.approved_by || row.approvedBy || "",
  deniedAt: row.denied_at || row.deniedAt || "",
  deniedBy: row.denied_by || row.deniedBy || "",
  removedAt: row.removed_at || row.removedAt || "",
  removedBy: row.removed_by || row.removedBy || "",
});

const publicPlayer = (row) => {
  const player = mapPlayer(row);
  return {
    id: player.id,
    displayName: player.displayName,
    rolePlay: player.rolePlay,
    teamName: player.teamName,
    twitchUsername: player.twitchUsername,
  };
};

const managePlayer = (row) => {
  const player = mapPlayer(row);
  return {
    id: player.id,
    username: player.username,
    discord: player.discord,
    displayName: player.displayName,
    battlenet: player.battlenet,
    rank: player.rank,
    rolePlay: player.rolePlay,
    timezone: player.timezone,
    twitchUsername: player.twitchUsername,
    teamName: player.teamName,
    availableAug12: player.availableAug12,
    email: player.email,
    status: player.status,
    notes: player.notes,
    createdAt: player.createdAt,
    approvedAt: player.approvedAt,
    approvedBy: player.approvedBy,
    deniedAt: player.deniedAt,
    deniedBy: player.deniedBy,
    removedAt: player.removedAt,
    removedBy: player.removedBy,
  };
};

export const validateTourneyPlayerPayload = (payload = {}) => {
  const email = normalizeTourneyEmail(payload.email);
  const password = String(payload.password || "");
  const passwordConfirm = String(
    payload.passwordConfirm || payload.password_confirm || ""
  );
  const discord = normalizeText(
    payload.discord || payload.discordUsername || payload.username
  );
  const displayName = normalizeText(
    payload.displayName || payload.display_name || payload.display
  );
  const username = buildInternalTourneyUsername(discord);
  const battlenet = normalizeText(payload.battlenet);
  const rank = normalizeText(payload.rank);
  const rolePlay = normalizeText(payload.rolePlay || payload.role_play);
  const timezone = normalizeText(payload.timezone || payload.time_zone);
  const twitchUsername = normalizeTwitchUsername(
    payload.twitchUsername || payload.twitch_username
  );
  const teamName = normalizeText(payload.teamName || payload.team_name);
  const notes = normalizeText(payload.notes);
  const availableAug12 =
    payload.availableAug12 === true ||
    payload.available_aug_1_2 === true ||
    payload.availableAug12 === "true" ||
    payload.available_aug_1_2 === "true" ||
    payload.availableAug12 === "on" ||
    payload.available_aug_1_2 === "on";

  const errors = [];
  if (!USERNAME_PATTERN.test(username)) {
    errors.push("Unable to generate a valid tournament login.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Enter a valid email.");
  }
  if (password.length < 8) {
    errors.push("Password must be at least 8 characters.");
  }
  if (password !== passwordConfirm) {
    errors.push("Passwords must match.");
  }
  if (!discord) errors.push("Discord Username is required.");
  if (!displayName) errors.push("Display Name is required.");
  if (!battlenet) errors.push("Battle.net BattleTag is required.");
  if (!TOURNEY_RANKS.includes(rank)) errors.push("Choose a rank.");
  if (!TOURNEY_ROLE_PLAYS.includes(rolePlay)) errors.push("Choose a role.");
  if (!TOURNEY_TIMEZONES.includes(timezone)) errors.push("Choose a timezone.");
  if (!twitchUsername) {
    errors.push("Enter a valid Twitch username.");
  }
  if (!availableAug12) errors.push("You must confirm August 1st and 2nd availability.");

  return {
    ok: errors.length === 0,
    errors,
    value: {
      username,
      email,
      password,
      discord,
      displayName,
      discordKey: normalizeDiscordKey(discord),
      battlenet,
      rank,
      rolePlay,
      timezone,
      twitchUsername,
      teamName,
      availableAug12,
      notes,
    },
  };
};

export const validateTourneyPlayerDetailsPayload = (payload = {}) => {
  const displayName = normalizeText(
    payload.displayName || payload.display_name || payload.display
  );
  const twitchUsername = normalizeTwitchUsername(
    payload.twitchUsername || payload.twitch_username
  );
  const teamName = normalizeText(payload.teamName || payload.team_name);
  const errors = [];

  if (!displayName) errors.push("Display Name is required.");
  if (!twitchUsername) errors.push("Enter a valid Twitch username.");

  return {
    ok: errors.length === 0,
    errors,
    value: {
      displayName,
      twitchUsername,
      teamName,
    },
  };
};

export async function ensureTourneyPlayerSchema(env = process.env) {
  if (isMemoryMode(env) || schemaReady) return;

  const sql = await getSql(env);
  await sql`
    create table if not exists tourney_players (
      id text primary key,
      username text not null unique,
      email text not null unique,
      password_hash text not null,
      status text not null default 'pending',
      discord text not null,
      display_name text,
      discord_key text not null unique,
      battlenet text not null,
      rank_name text not null,
      role_play text not null,
      time_zone text not null default '',
      twitch_username text,
      team_name text,
      available_aug_1_2 boolean not null default false,
      notes text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      approved_at timestamptz,
      approved_by text,
      denied_at timestamptz,
      denied_by text,
      removed_at timestamptz,
      removed_by text,
      constraint tourney_players_status_check
        check (status in ('pending', 'approved', 'denied', 'removed'))
    )
  `;
  await sql`
    alter table tourney_players
    add column if not exists time_zone text not null default ''
  `;
  await sql`
    alter table tourney_players
    add column if not exists display_name text
  `;
  await sql`
    alter table tourney_players
    add column if not exists team_name text
  `;
  await sql`
    create table if not exists tourney_player_tokens (
      id text primary key,
      player_id text not null references tourney_players(id) on delete cascade,
      token_hash text not null unique,
      purpose text not null,
      recipient_username text,
      recipient_email text,
      recipient_role text,
      recipient_version text,
      expires_at timestamptz not null,
      used_at timestamptz,
      used_by text,
      created_at timestamptz not null default now(),
      constraint tourney_player_tokens_purpose_check
        check (purpose in ('approve', 'deny', 'reset'))
    )
  `;
  schemaReady = true;
}

const assertNoDuplicatePlayer = async ({ value, env }) => {
  if (isMemoryMode(env)) {
    const getDiscordKey = (player) => player.discord_key || player.discordKey;
    const existing = MEMORY_STORE.players.find(
      (player) =>
        player.username === value.username ||
        player.email === value.email ||
        getDiscordKey(player) === value.discordKey
    );
    if (!existing) return;
    if (getDiscordKey(existing) === value.discordKey) {
      throw Object.assign(new Error("Discord is already registered."), {
        status: 409,
      });
    }
    if (existing.username === value.username) {
      throw Object.assign(new Error("Registration is already registered."), {
        status: 409,
      });
    }
    throw Object.assign(new Error("Email is already registered."), { status: 409 });
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select username, email, discord_key
    from tourney_players
    where username = ${value.username}
       or email = ${value.email}
       or discord_key = ${value.discordKey}
    limit 1
  `;
  const existing = rows?.[0];
  if (!existing) return;
  if (existing.discord_key === value.discordKey) {
    throw Object.assign(new Error("Discord is already registered."), {
      status: 409,
    });
  }
  if (existing.username === value.username) {
    throw Object.assign(new Error("Registration is already registered."), {
      status: 409,
    });
  }
  throw Object.assign(new Error("Email is already registered."), { status: 409 });
};

export async function createPendingTourneyPlayer({
  payload,
  recipients = [],
  env = process.env,
} = {}) {
  const validation = validateTourneyPlayerPayload(payload);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.errors[0] || "Invalid registration."), {
      status: 400,
      errors: validation.errors,
    });
  }

  const value = validation.value;
  await assertNoDuplicatePlayer({ value, env });

  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(value.password, 12);
  const createdAt = nowIso();
  const playerRow = {
    id,
    username: value.username,
    email: value.email,
    password_hash: passwordHash,
    status: "pending",
    discord: value.discord,
    display_name: value.displayName,
    discord_key: value.discordKey,
    battlenet: value.battlenet,
    rank_name: value.rank,
    role_play: value.rolePlay,
    time_zone: value.timezone,
    twitch_username: value.twitchUsername,
    team_name: value.teamName,
    available_aug_1_2: value.availableAug12,
    notes: value.notes,
    version: 1,
    created_at: createdAt,
    updated_at: createdAt,
  };

  const tokenRows = [];
  for (const recipient of recipients) {
    for (const purpose of ["approve", "deny"]) {
      const token = createPlainToken();
      tokenRows.push({
        id: crypto.randomUUID(),
        player_id: id,
        token,
        token_hash: tokenHash(token),
        purpose,
        recipient_username: recipient.username,
        recipient_email: recipient.email,
        recipient_role: recipient.role,
        recipient_version: String(recipient.version || "1"),
        expires_at: new Date(Date.now() + APPROVAL_TOKEN_MAX_AGE_MS).toISOString(),
        created_at: createdAt,
      });
    }
  }

  if (isMemoryMode(env)) {
    MEMORY_STORE.players.push(playerRow);
    MEMORY_STORE.tokens.push(...tokenRows);
    return {
      player: managePlayer(playerRow),
      tokens: tokenRows.map((row) => ({ ...row })),
    };
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  try {
    await sql`
      insert into tourney_players (
        id, username, email, password_hash, status, discord, display_name,
        discord_key, battlenet, rank_name, role_play, time_zone, twitch_username,
        team_name, available_aug_1_2, notes, version, created_at, updated_at
      )
      values (
        ${playerRow.id}, ${playerRow.username}, ${playerRow.email},
        ${playerRow.password_hash}, ${playerRow.status}, ${playerRow.discord},
        ${playerRow.display_name}, ${playerRow.discord_key}, ${playerRow.battlenet}, ${playerRow.rank_name},
        ${playerRow.role_play}, ${playerRow.time_zone}, ${playerRow.twitch_username},
        ${playerRow.team_name}, ${playerRow.available_aug_1_2}, ${playerRow.notes}, ${playerRow.version},
        ${playerRow.created_at}, ${playerRow.updated_at}
      )
    `;
    for (const row of tokenRows) {
      await sql`
        insert into tourney_player_tokens (
          id, player_id, token_hash, purpose, recipient_username,
          recipient_email, recipient_role, recipient_version, expires_at, created_at
        )
        values (
          ${row.id}, ${row.player_id}, ${row.token_hash}, ${row.purpose},
          ${row.recipient_username}, ${row.recipient_email}, ${row.recipient_role},
          ${row.recipient_version}, ${row.expires_at}, ${row.created_at}
        )
      `;
    }
  } catch (error) {
    if (String(error?.message || "").includes("duplicate")) {
      throw Object.assign(new Error("Registration already exists."), { status: 409 });
    }
    throw error;
  }

  return {
    player: managePlayer(playerRow),
    tokens: tokenRows.map((row) => ({ ...row })),
  };
}

export async function createApprovedTourneyPlayer({
  payload,
  actorUsername,
  env = process.env,
} = {}) {
  const validation = validateTourneyPlayerPayload(payload);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.errors[0] || "Invalid player."), {
      status: 400,
      errors: validation.errors,
    });
  }

  const value = validation.value;
  await assertNoDuplicatePlayer({ value, env });

  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(value.password, 12);
  const createdAt = nowIso();
  const playerRow = {
    id,
    username: value.username,
    email: value.email,
    password_hash: passwordHash,
    status: "approved",
    discord: value.discord,
    display_name: value.displayName,
    discord_key: value.discordKey,
    battlenet: value.battlenet,
    rank_name: value.rank,
    role_play: value.rolePlay,
    time_zone: value.timezone,
    twitch_username: value.twitchUsername,
    team_name: value.teamName,
    available_aug_1_2: value.availableAug12,
    notes: value.notes,
    version: 1,
    created_at: createdAt,
    updated_at: createdAt,
    approved_at: createdAt,
    approved_by: normalizeTourneyUsername(actorUsername),
  };

  if (isMemoryMode(env)) {
    MEMORY_STORE.players.push(playerRow);
    return managePlayer(playerRow);
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  await sql`
    insert into tourney_players (
      id, username, email, password_hash, status, discord, display_name,
      discord_key, battlenet, rank_name, role_play, time_zone, twitch_username,
      team_name, available_aug_1_2, notes, version, created_at, updated_at,
      approved_at, approved_by
    )
    values (
      ${playerRow.id}, ${playerRow.username}, ${playerRow.email},
      ${playerRow.password_hash}, ${playerRow.status}, ${playerRow.discord},
      ${playerRow.display_name}, ${playerRow.discord_key}, ${playerRow.battlenet}, ${playerRow.rank_name},
      ${playerRow.role_play}, ${playerRow.time_zone}, ${playerRow.twitch_username},
      ${playerRow.team_name}, ${playerRow.available_aug_1_2}, ${playerRow.notes}, ${playerRow.version},
      ${playerRow.created_at}, ${playerRow.updated_at}, ${playerRow.approved_at},
      ${playerRow.approved_by}
    )
  `;
  return managePlayer(playerRow);
}

export async function listApprovedTourneyPlayers({ env = process.env } = {}) {
  if (isMemoryMode(env)) {
    return MEMORY_STORE.players
      .filter((player) => player.status === "approved")
      .map(publicPlayer)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select *
    from tourney_players
    where status = 'approved'
    order by lower(coalesce(nullif(display_name, ''), discord)) asc
  `;
  return rows.map(publicPlayer);
}

export async function listManageTourneyPlayers({ env = process.env } = {}) {
  if (isMemoryMode(env)) {
    return MEMORY_STORE.players
      .map(managePlayer)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select *
    from tourney_players
    order by created_at desc
  `;
  return rows.map(managePlayer);
}

export async function updateTourneyPlayerDetails({
  playerId,
  payload,
  actorUsername,
  env = process.env,
} = {}) {
  const validation = validateTourneyPlayerDetailsPayload(payload);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.errors[0] || "Invalid player details."), {
      status: 400,
      errors: validation.errors,
    });
  }

  const value = validation.value;
  const actor = normalizeTourneyUsername(actorUsername);
  const now = nowIso();

  if (isMemoryMode(env)) {
    const player = MEMORY_STORE.players.find((entry) => entry.id === playerId);
    if (!player) {
      throw Object.assign(new Error("Player not found."), { status: 404 });
    }
    player.display_name = value.displayName;
    player.twitch_username = value.twitchUsername;
    player.team_name = value.teamName;
    player.updated_at = now;
    player.updated_by = actor;
    player.version = Number(player.version || 1) + 1;
    return managePlayer(player);
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    update tourney_players
    set display_name = ${value.displayName},
        twitch_username = ${value.twitchUsername},
        team_name = ${value.teamName},
        updated_at = ${now},
        version = version + 1
    where id = ${playerId}
    returning *
  `;
  if (!rows?.[0]) {
    throw Object.assign(new Error("Player not found."), { status: 404 });
  }
  return managePlayer(rows[0]);
}

export async function getRegistrationDecisionToken({
  token,
  purpose,
  env = process.env,
} = {}) {
  const hashed = tokenHash(token);
  const now = nowIso();

  if (isMemoryMode(env)) {
    const row = MEMORY_STORE.tokens.find(
      (entry) =>
        entry.token_hash === hashed &&
        entry.purpose === purpose &&
        !entry.used_at &&
        entry.expires_at > now
    );
    return row ? { ...row } : null;
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select *
    from tourney_player_tokens
    where token_hash = ${hashed}
      and purpose = ${purpose}
      and used_at is null
      and expires_at > now()
    limit 1
  `;
  return rows?.[0] || null;
}

export async function applyRegistrationDecision({
  tokenHash,
  playerId,
  purpose,
  actorUsername,
  env = process.env,
} = {}) {
  const actor = normalizeTourneyUsername(actorUsername);
  const status = purpose === "approve" ? "approved" : "denied";
  const now = nowIso();

  if (!["approve", "deny"].includes(purpose)) {
    throw Object.assign(new Error("Unsupported decision."), { status: 400 });
  }

  if (isMemoryMode(env)) {
    const player = MEMORY_STORE.players.find((entry) => entry.id === playerId);
    if (!player || player.status !== "pending") {
      throw Object.assign(new Error("Registration is no longer pending."), {
        status: 409,
      });
    }
    player.status = status;
    player.version = Number(player.version || 1) + 1;
    player.updated_at = now;
    if (status === "approved") {
      player.approved_at = now;
      player.approved_by = actor;
    } else {
      player.denied_at = now;
      player.denied_by = actor;
    }
    for (const token of MEMORY_STORE.tokens) {
      if (token.player_id === playerId && ["approve", "deny"].includes(token.purpose)) {
        token.used_at = now;
        token.used_by = actor;
      }
    }
    return managePlayer(player);
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows =
    status === "approved"
      ? await sql`
          update tourney_players
          set status = 'approved',
              approved_at = ${now},
              approved_by = ${actor},
              updated_at = ${now},
              version = version + 1
          where id = ${playerId}
            and status = 'pending'
          returning *
        `
      : await sql`
          update tourney_players
          set status = 'denied',
              denied_at = ${now},
              denied_by = ${actor},
              updated_at = ${now},
              version = version + 1
          where id = ${playerId}
            and status = 'pending'
          returning *
        `;
  const player = rows?.[0];
  if (!player) {
    throw Object.assign(new Error("Registration is no longer pending."), {
      status: 409,
    });
  }

  await sql`
    update tourney_player_tokens
    set used_at = ${now}, used_by = ${actor}
    where player_id = ${playerId}
      and purpose in ('approve', 'deny')
      and used_at is null
  `;
  await sql`
    update tourney_player_tokens
    set used_at = ${now}, used_by = ${actor}
    where token_hash = ${tokenHash}
      and used_at is null
  `;

  return managePlayer(player);
}

export async function kickTourneyPlayer({
  playerId,
  actorUsername,
  env = process.env,
} = {}) {
  const actor = normalizeTourneyUsername(actorUsername);
  const now = nowIso();

  if (isMemoryMode(env)) {
    const player = MEMORY_STORE.players.find((entry) => entry.id === playerId);
    if (!player || player.status !== "approved") {
      throw Object.assign(new Error("Only approved players can be kicked."), {
        status: 400,
      });
    }
    player.status = "removed";
    player.version = Number(player.version || 1) + 1;
    player.updated_at = now;
    player.removed_at = now;
    player.removed_by = actor;
    return managePlayer(player);
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    update tourney_players
    set status = 'removed',
        removed_at = ${now},
        removed_by = ${actor},
        updated_at = ${now},
        version = version + 1
    where id = ${playerId}
      and status = 'approved'
    returning *
  `;
  if (!rows?.[0]) {
    throw Object.assign(new Error("Only approved players can be kicked."), {
      status: 400,
    });
  }
  return managePlayer(rows[0]);
}

export async function verifyTourneyPlayerCredentials({
  login,
  password,
  env = process.env,
} = {}) {
  const normalizedLogin = normalizeTourneyUsername(login);
  const normalizedEmail = normalizeTourneyEmail(login);
  const normalizedDiscordKey = normalizeDiscordKey(login);
  let row = null;

  if (isMemoryMode(env)) {
    const getDiscordKey = (player) => player.discord_key || player.discordKey;
    row =
      MEMORY_STORE.players.find(
        (player) =>
          player.username === normalizedLogin ||
            player.email === normalizedEmail ||
            getDiscordKey(player) === normalizedDiscordKey
      ) || null;
  } else if (getDatabaseUrl(env)) {
    await ensureTourneyPlayerSchema(env);
    const sql = await getSql(env);
    const rows = await sql`
      select *
      from tourney_players
      where username = ${normalizedLogin}
         or email = ${normalizedEmail}
         or discord_key = ${normalizedDiscordKey}
      limit 1
    `;
    row = rows?.[0] || null;
  }

  const candidateHash = row?.password_hash || DUMMY_PLAYER_HASH;
  const passwordMatches = await bcrypt.compare(String(password || ""), candidateHash);
  if (!row || !passwordMatches || row.status !== "approved") {
    const player = row ? mapPlayer(row) : null;
    return {
      ok: false,
      account: null,
      reason: player?.status === "removed" && passwordMatches ? "suspended" : "",
    };
  }

  const player = mapPlayer(row);
  return {
    ok: true,
    account: {
      username: player.username,
      role: "player",
      version: player.version,
      playerId: player.id,
    },
  };
}

export async function findTourneyPlayerForSession({
  username,
  version,
  env = process.env,
} = {}) {
  const normalizedUsername = normalizeTourneyUsername(username);

  if (isMemoryMode(env)) {
    const row = MEMORY_STORE.players.find(
      (player) =>
        player.status === "approved" &&
        player.username === normalizedUsername &&
        String(player.version || "1") === String(version || "1")
    );
    return row ? mapPlayer(row) : null;
  }

  if (!getDatabaseUrl(env)) return null;

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select *
    from tourney_players
    where status = 'approved'
      and username = ${normalizedUsername}
      and version = ${Number(version || 1)}
    limit 1
  `;
  return rows?.[0] ? mapPlayer(rows[0]) : null;
}

export async function createTourneyResetToken({
  login,
  env = process.env,
} = {}) {
  const normalizedLogin = normalizeTourneyUsername(login);
  const normalizedEmail = normalizeTourneyEmail(login);
  const normalizedDiscordKey = normalizeDiscordKey(login);
  const plainToken = createPlainToken();
  const hashed = tokenHash(plainToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_MAX_AGE_MS).toISOString();
  const now = nowIso();

  if (isMemoryMode(env)) {
    const getDiscordKey = (player) => player.discord_key || player.discordKey;
    const player = MEMORY_STORE.players.find(
      (entry) =>
        entry.status === "approved" &&
        (entry.username === normalizedLogin ||
          entry.email === normalizedEmail ||
          getDiscordKey(entry) === normalizedDiscordKey)
    );
    if (!player) return null;
    MEMORY_STORE.tokens.push({
      id: crypto.randomUUID(),
      player_id: player.id,
      token: plainToken,
      token_hash: hashed,
      purpose: "reset",
      expires_at: expiresAt,
      created_at: now,
    });
    return { player: managePlayer(player), token: plainToken };
  }

  if (!getDatabaseUrl(env)) return null;
  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const players = await sql`
    select *
    from tourney_players
    where status = 'approved'
      and (
        username = ${normalizedLogin}
        or email = ${normalizedEmail}
        or discord_key = ${normalizedDiscordKey}
      )
    limit 1
  `;
  const player = players?.[0];
  if (!player) return null;
  await sql`
    insert into tourney_player_tokens (
      id, player_id, token_hash, purpose, expires_at, created_at
    )
    values (
      ${crypto.randomUUID()}, ${player.id}, ${hashed}, 'reset', ${expiresAt}, ${now}
    )
  `;
  return { player: managePlayer(player), token: plainToken };
}

export async function resetTourneyPlayerPassword({
  token,
  password,
  env = process.env,
} = {}) {
  if (String(password || "").length < 8) {
    throw Object.assign(new Error("Password must be at least 8 characters."), {
      status: 400,
    });
  }

  const hashedToken = tokenHash(token);
  const passwordHash = await bcrypt.hash(String(password), 12);
  const now = nowIso();

  if (isMemoryMode(env)) {
    const resetToken = MEMORY_STORE.tokens.find(
      (entry) =>
        entry.token_hash === hashedToken &&
        entry.purpose === "reset" &&
        !entry.used_at &&
        entry.expires_at > now
    );
    const player = resetToken
      ? MEMORY_STORE.players.find(
          (entry) => entry.id === resetToken.player_id && entry.status === "approved"
        )
      : null;
    if (!resetToken || !player) {
      throw Object.assign(new Error("Invalid or expired reset link."), {
        status: 400,
      });
    }
    player.password_hash = passwordHash;
    player.version = Number(player.version || 1) + 1;
    player.updated_at = now;
    resetToken.used_at = now;
    resetToken.used_by = player.username;
    return managePlayer(player);
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const tokens = await sql`
    select *
    from tourney_player_tokens
    where token_hash = ${hashedToken}
      and purpose = 'reset'
      and used_at is null
      and expires_at > now()
    limit 1
  `;
  const resetToken = tokens?.[0];
  if (!resetToken) {
    throw Object.assign(new Error("Invalid or expired reset link."), { status: 400 });
  }
  const rows = await sql`
    update tourney_players
    set password_hash = ${passwordHash},
        updated_at = ${now},
        version = version + 1
    where id = ${resetToken.player_id}
      and status = 'approved'
    returning *
  `;
  if (!rows?.[0]) {
    throw Object.assign(new Error("Invalid or expired reset link."), { status: 400 });
  }
  await sql`
    update tourney_player_tokens
    set used_at = ${now}, used_by = ${rows[0].username}
    where id = ${resetToken.id}
  `;
  return managePlayer(rows[0]);
}
