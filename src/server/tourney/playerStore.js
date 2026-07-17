import crypto from "crypto";
import bcrypt from "bcryptjs";
import { isEnabledTourneyFlag } from "./canonical.js";
import {
  extractTwitchLogin,
  getTwitchLiveStatusMap,
  getTwitchProfileImageMap,
  normalizeTwitchUsername,
} from "./twitch.js";
import {
  assertTourneySchemaVersion,
  getTourneySql as getSql,
  isSupabaseTourneyDatabase,
  resolveTourneyDatabaseUrl as getDatabaseUrl,
  runTourneyTransaction,
} from "./sqlClient.js";
import { enqueueTourneyExternalOperation } from "./externalOperations.js";
import {
  claimSupabasePasswordReset,
  claimSupabaseRegistrationDecision,
  completeSupabaseAuthOperation,
  finalizeSupabasePasswordReset,
  finalizeSupabaseRegistrationDecision,
} from "./supabaseAuthOperations.js";

export const TOURNEY_PLAYER_STATUSES = Object.freeze([
  "pending",
  "approved",
  "denied",
  "withdrawn",
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
export const TOURNEY_REGISTRATION_POOLS = Object.freeze([
  "main",
  "substitute",
]);
export const TOURNEY_DEFAULT_TEAM_COUNT = 8;
export const TOURNEY_REGISTRATION_CLOSES_AT_UTC =
  "2026-07-22T00:00:00.000Z";
export const TOURNEY_FROGGER_RESERVED_ROLE = "Support";
export const TOURNEY_FROGGER_DISPLAY_NAME = "Frogger";
export const TOURNEY_FROGGER_TWITCH_USERNAME = "froggerow";
const TOURNEY_CONFIG_ID = "legacy-series-2026";
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
const APPROVAL_TOKEN_NO_EXPIRES_AT = "9999-12-31T23:59:59.999Z";
const RESET_TOKEN_MAX_AGE_MS = 60 * 60 * 1000;
const DUMMY_PLAYER_HASH =
  // nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash
  "$2b$10$t6/bHTKT3hABxzcK8HIMauYsrY88CioIiiq0Cwci4RPXbOq30kAWy";

const MEMORY_STORE =
  globalThis.__rooTourneyPlayerStore ||
  (globalThis.__rooTourneyPlayerStore = {
    players: [],
    tokens: [],
    registrationConfig: {
      teamCount: TOURNEY_DEFAULT_TEAM_COUNT,
      updatedAt: "",
      updatedBy: "",
    },
  });
export const normalizeTourneyUsername = (value) =>
  String(value || "").trim().toLowerCase();

export const normalizeTourneyEmail = (value) =>
  String(value || "").trim().toLowerCase();

export const normalizeDiscordKey = (value) =>
  String(value || "").trim().toLowerCase().replace(/\s+/g, "");

const normalizeText = (value) => String(value || "").trim();
const USERNAME_PATTERN = /^[a-z0-9_.-]{3,24}$/;

const nowIso = () => new Date().toISOString();

const getRegistrationCloseTime = (env = process.env) => {
  const configured = normalizeText(env.TOURNEY_REGISTRATION_CLOSES_AT_UTC);
  const value = configured || TOURNEY_REGISTRATION_CLOSES_AT_UTC;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? timestamp
    : Date.parse(TOURNEY_REGISTRATION_CLOSES_AT_UTC);
};

export const isTourneyRegistrationClosed = ({
  env = process.env,
  now = Date.now(),
} = {}) => Number(now) >= getRegistrationCloseTime(env);

export const getTourneyRegistrationCloseIso = (env = process.env) =>
  new Date(getRegistrationCloseTime(env)).toISOString();

const normalizeRegistrationPool = (value) =>
  TOURNEY_REGISTRATION_POOLS.includes(String(value || "").trim().toLowerCase())
    ? String(value || "").trim().toLowerCase()
    : "main";

const parseBooleanField = (value) =>
  value === true || value === "true" || value === "on" || value === "1";

const normalizeRolePlay = (value) => normalizeText(value);

const getPrimaryRolePlay = (player = {}) =>
  normalizeRolePlay(player.role_play || player.primaryRolePlay || player.rolePlay);

const getSecondaryRolePlay = (player = {}) =>
  normalizeRolePlay(player.secondary_role_play || player.secondaryRolePlay);

const getApprovedRolePlay = (player = {}) =>
  normalizeRolePlay(player.approved_role_play || player.approvedRolePlay);

const getEffectiveRolePlay = (player = {}) =>
  getApprovedRolePlay(player) || getPrimaryRolePlay(player);

const getSubmittedRolePlays = (player = {}) =>
  [...new Set([getPrimaryRolePlay(player), getSecondaryRolePlay(player)])].filter(
    (role) => TOURNEY_ROLE_PLAYS.includes(role)
  );

const resolveApprovedRolePlay = (player = {}, requestedRole = "") => {
  const submittedRoles = getSubmittedRolePlays(player);
  const selectedRole = normalizeRolePlay(requestedRole) || submittedRoles[0] || "";
  if (!TOURNEY_ROLE_PLAYS.includes(selectedRole)) {
    throw Object.assign(new Error("Choose a valid approval role."), {
      status: 400,
    });
  }
  if (!submittedRoles.includes(selectedRole)) {
    throw Object.assign(new Error("Approval role must match a submitted role."), {
      status: 400,
    });
  }
  return selectedRole;
};

const isFroggerReservedRegistration = (player = {}) =>
  getEffectiveRolePlay(player) === TOURNEY_FROGGER_RESERVED_ROLE &&
  normalizeTourneyUsername(player.displayName || player.display_name) ===
    normalizeTourneyUsername(TOURNEY_FROGGER_DISPLAY_NAME) &&
  normalizeTwitchUsername(player.twitchUsername || player.twitch_username) ===
    TOURNEY_FROGGER_TWITCH_USERNAME;

const normalizeTeamCount = (value) => {
  const teamCount = Number(value);
  if (!Number.isInteger(teamCount) || teamCount < 2 || teamCount > 64) {
    throw Object.assign(
      new Error("Team count must be a whole number from 2 to 64."),
      { status: 400 }
    );
  }
  return teamCount;
};

const getMemoryRegistrationConfig = () => {
  if (!MEMORY_STORE.registrationConfig) {
    MEMORY_STORE.registrationConfig = {
      teamCount: TOURNEY_DEFAULT_TEAM_COUNT,
      updatedAt: "",
      updatedBy: "",
    };
  }
  return MEMORY_STORE.registrationConfig;
};

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

export const createTourneyPasswordHash = async ({
  allowGenerated = false,
  password = "",
} = {}) => {
  const material = String(password || "") ||
    (allowGenerated ? crypto.randomBytes(32).toString("base64url") : "");
  if (material.length < 8) {
    throw Object.assign(new Error("Password must be at least 8 characters."), {
      status: 400,
    });
  }
  return bcrypt.hash(material, 12);
};

const isMemoryMode = (env = process.env) =>
  env.TOURNEY_PLAYER_STORE_MODE === "memory" ||
  env.TOURNEY_DATABASE_MODE === "memory";

const shouldSyncSupabasePlayerAuth = (env = process.env) =>
  isSupabaseTourneyDatabase(env) ||
  isEnabledTourneyFlag(env.SUPABASE_SOCIAL_AUTH_ENABLED) ||
  isEnabledTourneyFlag(env.SUPABASE_SHADOW_WRITES);

const syncTourneyPlayerAuth = async ({
  installPassword = true,
  playerRow,
  authUserId = "",
  env = process.env,
}) => {
  const shouldSyncAuth = shouldSyncSupabasePlayerAuth(env) || Boolean(authUserId);
  if (!shouldSyncAuth && isMemoryMode(env)) return;
  const sql = await getSql(env);
  const [context] = await sql`
    select nullif(current_setting('roo.tourney_command_id', true), '') as command_id
  `;
  if (!context?.command_id) {
    const error = new Error("Tourney player Auth synchronization requires a command.");
    error.code = "TOURNEY_COMMAND_CONTEXT_REQUIRED";
    throw error;
  }
  const { queueTourneyDiscordStateForPlayerMutation } = await import(
    "./discordDesiredState.js"
  );
  await queueTourneyDiscordStateForPlayerMutation({
    commandId: context.command_id,
    player: playerRow,
    env,
  });
  if (!shouldSyncAuth) return;
  await enqueueTourneyExternalOperation({
    commandId: context.command_id,
    operationKind: "supabase_player_auth",
    entityType: "player",
    entityId: playerRow.id,
    desiredState: {
      player: playerRow,
      authUserId,
      installPassword,
    },
    env,
  });
};

export const hashTourneyToken = tokenHash;

export const resetMemoryTourneyPlayerStoreForTests = () => {
  MEMORY_STORE.players = [];
  MEMORY_STORE.tokens = [];
  MEMORY_STORE.registrationConfig = {
    teamCount: TOURNEY_DEFAULT_TEAM_COUNT,
    updatedAt: "",
    updatedBy: "",
  };
};

const mapPlayer = (row = {}) => ({
  id: row.id,
  principalId: row.principal_id || row.principalId || "",
  username: row.username,
  email: row.email,
  status: row.status,
  discord: row.discord,
  displayName: row.display_name || row.displayName || row.discord || "",
  discordKey: row.discord_key || row.discordKey,
  battlenet: row.battlenet,
  rank: row.rank_name || row.rank,
  primaryRolePlay: getPrimaryRolePlay(row),
  secondaryRolePlay: getSecondaryRolePlay(row),
  approvedRolePlay: getApprovedRolePlay(row),
  rolePlay: getEffectiveRolePlay(row),
  registrationPool: normalizeRegistrationPool(
    row.registration_pool || row.registrationPool
  ),
  timezone: row.time_zone || row.timezone || "",
  twitchUsername: extractTwitchLogin(row.twitch_username || row.twitchUsername),
  teamName: row.team_name || row.teamName || "",
  availableAug12: Boolean(row.available_aug_1_2 ?? row.availableAug12),
  acceptedRules: Boolean(row.accepted_rules ?? row.acceptedRules),
  acceptedRooVisibility: Boolean(
    row.accepted_roo_visibility ?? row.acceptedRooVisibility
  ),
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
  withdrawnAt: row.withdrawn_at || row.withdrawnAt || "",
  withdrawnBy: row.withdrawn_by || row.withdrawnBy || "",
  discordInviteSentAt: row.discord_invite_sent_at || row.discordInviteSentAt || "",
  discordInviteEmailId: row.discord_invite_email_id || row.discordInviteEmailId || "",
  discordInviteLastError:
    row.discord_invite_last_error || row.discordInviteLastError || "",
  discordUserId: row.discord_user_id || row.discordUserId || "",
  discordOauthUsername:
    row.discord_oauth_username || row.discordOauthUsername || "",
  discordOauthGlobalName:
    row.discord_oauth_global_name || row.discordOauthGlobalName || "",
  discordLinkedAt: row.discord_linked_at || row.discordLinkedAt || "",
  discordRoleAssignedAt:
    row.discord_role_assigned_at || row.discordRoleAssignedAt || "",
  discordRoleLastError:
    row.discord_role_last_error || row.discordRoleLastError || "",
});

const publicPlayer = (row) => {
  const player = mapPlayer(row);
  return {
    id: player.id,
    displayName: player.displayName,
    rolePlay: player.rolePlay,
    registrationPool: player.registrationPool,
    teamName: player.teamName,
    twitchUsername: player.twitchUsername,
  };
};

const attachTwitchRosterMetadata = async (
  players,
  { env = process.env } = {}
) => {
  const twitchUsernames = players.map((player) => player.twitchUsername);
  const injectedSnapshot = env.__TOURNEY_TWITCH_SHADOW_SNAPSHOT;
  const [profileImages, liveStatuses] = injectedSnapshot !== undefined
    ? [
        new Map(Object.entries(injectedSnapshot?.profileImages || {})),
        new Map(Object.entries(injectedSnapshot?.liveStatuses || {})),
      ]
    : await Promise.all([
        getTwitchProfileImageMap(twitchUsernames, { env }).catch(() => new Map()),
        getTwitchLiveStatusMap(twitchUsernames, { env }).catch(() => new Map()),
      ]);

  if (!profileImages.size && !liveStatuses.size) return players;

  return players.map((player) => {
    const imageUrl = profileImages.get(player.twitchUsername);
    const liveStatus = liveStatuses.get(player.twitchUsername);
    return {
      ...player,
      ...(imageUrl ? { twitchProfileImageUrl: imageUrl } : {}),
      ...(liveStatus?.isLive
        ? {
            twitchLive: true,
            twitchLiveTitle: liveStatus.title,
            twitchLiveGameName: liveStatus.gameName,
            twitchLiveViewerCount: liveStatus.viewerCount,
            twitchLiveStartedAt: liveStatus.startedAt,
          }
        : {}),
    };
  });
};

export const getTourneyTwitchRosterMetadataSnapshot = async ({
  usernames = [],
  env = process.env,
} = {}) => {
  const normalized = [...new Set(usernames.map(normalizeTwitchUsername).filter(Boolean))];
  const [profileImages, liveStatuses] = await Promise.all([
    getTwitchProfileImageMap(normalized, { env }).catch(() => new Map()),
    getTwitchLiveStatusMap(normalized, { env }).catch(() => new Map()),
  ]);
  return {
    profileImages: Object.fromEntries(profileImages),
    liveStatuses: Object.fromEntries(liveStatuses),
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
    primaryRolePlay: player.primaryRolePlay,
    secondaryRolePlay: player.secondaryRolePlay,
    approvedRolePlay: player.approvedRolePlay,
    registrationPool: player.registrationPool,
    timezone: player.timezone,
    twitchUsername: player.twitchUsername,
    teamName: player.teamName,
    availableAug12: player.availableAug12,
    acceptedRules: player.acceptedRules,
    acceptedRooVisibility: player.acceptedRooVisibility,
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
    withdrawnAt: player.withdrawnAt,
    withdrawnBy: player.withdrawnBy,
    version: player.version,
    discordInviteSentAt: player.discordInviteSentAt,
    discordInviteEmailId: player.discordInviteEmailId,
    discordInviteLastError: player.discordInviteLastError,
    discordUserId: player.discordUserId,
    discordOauthUsername: player.discordOauthUsername,
    discordOauthGlobalName: player.discordOauthGlobalName,
    discordLinkedAt: player.discordLinkedAt,
    discordRoleAssignedAt: player.discordRoleAssignedAt,
    discordRoleLastError: player.discordRoleLastError,
  };
};

export const validateTourneyPlayerPayload = (
  payload = {},
  { allowPasswordless = false, requireAgreements = false } = {}
) => {
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
  const secondaryRolePlay = normalizeText(
    payload.secondaryRolePlay || payload.secondary_role_play
  );
  const registrationPool = normalizeRegistrationPool(
    payload.registrationPool || payload.registration_pool
  );
  const timezone = normalizeText(payload.timezone || payload.time_zone);
  const twitchUsername = normalizeTwitchUsername(
    payload.twitchUsername || payload.twitch_username
  );
  const teamName = normalizeText(payload.teamName || payload.team_name);
  const notes = normalizeText(payload.notes);
  const availableAug12 =
    parseBooleanField(payload.availableAug12) ||
    parseBooleanField(payload.available_aug_1_2);
  const acceptedRules =
    parseBooleanField(payload.acceptedRules) ||
    parseBooleanField(payload.accepted_rules);
  const acceptedCreatorEligibility =
    parseBooleanField(payload.acceptedCreatorEligibility) ||
    parseBooleanField(payload.accepted_creator_eligibility);
  const acceptedRooVisibility =
    parseBooleanField(payload.acceptedRooVisibility) ||
    parseBooleanField(payload.accepted_roo_visibility);
  const acceptSubstitutePool =
    parseBooleanField(payload.acceptSubstitutePool) ||
    parseBooleanField(payload.accept_substitute_pool);

  const errors = [];
  if (!USERNAME_PATTERN.test(username)) {
    errors.push("Unable to generate a valid tournament login.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Enter a valid email.");
  }
  if ((!allowPasswordless || password.length > 0) && password.length < 8) {
    errors.push("Password must be at least 8 characters.");
  }
  if ((!allowPasswordless || password || passwordConfirm) && password !== passwordConfirm) {
    errors.push("Passwords must match.");
  }
  if (!discord) errors.push("Discord Username is required.");
  if (!displayName) errors.push("Display Name is required.");
  if (!battlenet) errors.push("Battle.net BattleTag is required.");
  if (!TOURNEY_RANKS.includes(rank)) errors.push("Choose a rank.");
  if (!TOURNEY_ROLE_PLAYS.includes(rolePlay)) errors.push("Choose a role.");
  if (secondaryRolePlay && !TOURNEY_ROLE_PLAYS.includes(secondaryRolePlay)) {
    errors.push("Choose a valid secondary role.");
  }
  if (secondaryRolePlay && secondaryRolePlay === rolePlay) {
    errors.push("Secondary role must be different from primary role.");
  }
  if (!TOURNEY_TIMEZONES.includes(timezone)) errors.push("Choose a timezone.");
  if (!twitchUsername) {
    errors.push("Enter a valid Twitch username.");
  }
  if (!availableAug12) errors.push("You must confirm August 15th and 16th availability.");
  if (requireAgreements && !acceptedRules) {
    errors.push("You must agree to follow the tournament rules.");
  }
  if (requireAgreements && !acceptedCreatorEligibility) {
    errors.push("You must confirm creator eligibility.");
  }
  if (requireAgreements && !acceptedRooVisibility) {
    errors.push("You must acknowledge the event visibility note.");
  }

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
      secondaryRolePlay,
      registrationPool,
      timezone,
      twitchUsername,
      teamName,
      availableAug12,
      acceptedRules,
      acceptedCreatorEligibility,
      acceptedRooVisibility,
      acceptSubstitutePool,
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
  const registrationPool = normalizeRegistrationPool(
    payload.registrationPool || payload.registration_pool
  );
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
      registrationPool,
    },
  };
};

export async function ensureTourneyPlayerSchema(env = process.env) {
  if (isMemoryMode(env)) return;
  await assertTourneySchemaVersion(env);
}

export async function getTourneyRegistrationConfig({ env = process.env } = {}) {
  if (isMemoryMode(env)) {
    const config = getMemoryRegistrationConfig();
    return {
      teamCount: normalizeTeamCount(config.teamCount || TOURNEY_DEFAULT_TEAM_COUNT),
      updatedAt: config.updatedAt || "",
      updatedBy: config.updatedBy || "",
    };
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select team_count, updated_at, updated_by
    from tourney_registration_config
    where id = ${TOURNEY_CONFIG_ID}
    limit 1
  `;
  const row = rows?.[0] || {};
  return {
    teamCount: normalizeTeamCount(row.team_count || TOURNEY_DEFAULT_TEAM_COUNT),
    updatedAt: row.updated_at || "",
    updatedBy: row.updated_by || "",
  };
}

export async function updateTourneyRegistrationConfig({
  teamCount,
  actorUsername,
  env = process.env,
} = {}) {
  const nextTeamCount = normalizeTeamCount(teamCount);
  const actor = normalizeTourneyUsername(actorUsername);
  const updatedAt = nowIso();

  if (isMemoryMode(env)) {
    const players = await listCapacityPlayers({ env });
    const snapshot = buildTourneyRoleCapacitySnapshot({
      config: { teamCount: nextTeamCount },
      players,
    });
    const overCapacity = snapshot.roles.find((role) =>
      role.mainCount > role.cap || role.reservedCount > role.reservedCap
    );
    if (overCapacity) throw roleCapacityError({ role: overCapacity.role, snapshot });
    MEMORY_STORE.registrationConfig = {
      teamCount: nextTeamCount,
      updatedAt,
      updatedBy: actor,
    };
    return getTourneyRegistrationConfig({ env });
  }

  return runTourneyRegistrationCapacityTransaction({
    env,
    callback: async (sql) => {
      const capacityPlayers = await listCapacityPlayers({ env });
      const nextSnapshot = buildTourneyRoleCapacitySnapshot({
        config: { teamCount: nextTeamCount },
        players: capacityPlayers,
      });
      const overCapacity = nextSnapshot.roles.find((role) =>
        role.mainCount > role.cap || role.reservedCount > role.reservedCap
      );
      if (overCapacity) {
        throw roleCapacityError({ role: overCapacity.role, snapshot: nextSnapshot });
      }
      const rows = await sql`
        insert into tourney_registration_config (
          id, team_count, updated_at, updated_by
        )
        values (
          ${TOURNEY_CONFIG_ID}, ${nextTeamCount}, ${updatedAt}, ${actor}
        )
        on conflict (id) do update set
          team_count = excluded.team_count,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
        returning *
      `;
      const row = rows?.[0] || {};
      return {
        teamCount: normalizeTeamCount(row.team_count || nextTeamCount),
        updatedAt: row.updated_at || updatedAt,
        updatedBy: row.updated_by || actor,
      };
    },
  });
}

const listCapacityPlayers = async ({ env = process.env } = {}) => {
  if (isMemoryMode(env)) {
    return MEMORY_STORE.players
      .filter((player) => player.status === "approved")
      .map(mapPlayer);
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select id, status, display_name, discord, role_play, approved_role_play,
      registration_pool, twitch_username
    from tourney_players
    where status = 'approved'
  `;
  return rows.map(mapPlayer);
};

export const buildTourneyRoleCapacitySnapshot = ({
  players = [],
  config = { teamCount: TOURNEY_DEFAULT_TEAM_COUNT },
} = {}) => {
  const teamCount = normalizeTeamCount(
    config.teamCount || TOURNEY_DEFAULT_TEAM_COUNT
  );
  const totalCap = teamCount * 2;
  const roles = TOURNEY_ROLE_PLAYS.map((role) => {
    const hasReservedSlot = role === TOURNEY_FROGGER_RESERVED_ROLE;
    const reservedCap = hasReservedSlot ? 1 : 0;
    const cap = Math.max(totalCap - reservedCap, 0);
    const rolePlayers = players.filter((player) => player.rolePlay === role);
    const mainPlayers = rolePlayers.filter(
      (player) => normalizeRegistrationPool(player.registrationPool) === "main"
    );
    const reservedMainPlayers = mainPlayers.filter(isFroggerReservedRegistration);
    const regularMainPlayers = mainPlayers.filter(
      (player) => !isFroggerReservedRegistration(player)
    );
    const pendingMainPlayers = mainPlayers.filter(
      (player) => player.status === "pending"
    );
    const pendingRegularMainPlayers = regularMainPlayers.filter(
      (player) => player.status === "pending"
    );
    const approvedMainPlayers = regularMainPlayers.filter(
      (player) => player.status === "approved"
    );
    const approvedReservedMainPlayers = reservedMainPlayers.filter(
      (player) => player.status === "approved"
    );
    const substitutePlayers = rolePlayers.filter(
      (player) =>
        normalizeRegistrationPool(player.registrationPool) === "substitute"
    );
    return {
      role,
      cap,
      totalCap,
      mainCount: approvedMainPlayers.length,
      totalMainCount:
        approvedMainPlayers.length + approvedReservedMainPlayers.length,
      substituteCount: substitutePlayers.length,
      pendingMainCount: pendingRegularMainPlayers.length,
      totalPendingMainCount: pendingMainPlayers.length,
      approvedMainCount: approvedMainPlayers.length,
      reservedFor: hasReservedSlot ? TOURNEY_FROGGER_DISPLAY_NAME : "",
      reservedCap,
      reservedCount: approvedReservedMainPlayers.length,
      reservedIsFull: approvedReservedMainPlayers.length >= reservedCap,
      isFull: approvedMainPlayers.length >= cap,
    };
  });

  return {
    teamCount,
    updatedAt: config.updatedAt || "",
    updatedBy: config.updatedBy || "",
    roles,
  };
};

export async function getTourneyRoleCapacitySnapshot({
  env = process.env,
} = {}) {
  const [config, players] = await Promise.all([
    getTourneyRegistrationConfig({ env }),
    listCapacityPlayers({ env }),
  ]);
  return buildTourneyRoleCapacitySnapshot({ config, players });
}

const readManageTourneyPlayersSnapshot = async (env) => {
  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const [snapshot] = await sql`
    select
      coalesce(
        jsonb_agg(to_jsonb(player_rows) order by player_rows.created_at desc)
          filter (where player_rows.id is not null),
        '[]'::jsonb
      ) as players,
      coalesce(
        (
          select jsonb_build_object(
            'team_count', team_count,
            'updated_at', updated_at,
            'updated_by', updated_by
          )
          from tourney_registration_config
          where id = ${TOURNEY_CONFIG_ID}
          limit 1
        ),
        jsonb_build_object(
          'team_count', ${TOURNEY_DEFAULT_TEAM_COUNT}::integer,
          'updated_at', '',
          'updated_by', ''
        )
      ) as config
    from (
      select id, username, email, status, discord, display_name, discord_key,
        battlenet, rank_name, role_play, secondary_role_play, approved_role_play,
        registration_pool, time_zone, twitch_username, team_name,
        available_aug_1_2, accepted_rules, accepted_roo_visibility, notes,
        version, created_at, updated_at, approved_at, approved_by, denied_at,
        denied_by, removed_at, removed_by, withdrawn_at, withdrawn_by,
        discord_invite_sent_at, discord_invite_email_id,
        discord_invite_last_error, discord_user_id, discord_oauth_username,
        discord_oauth_global_name, discord_linked_at, discord_role_assigned_at,
        discord_role_last_error
      from tourney_players
    ) player_rows
  `;
  return snapshot || {};
};

const buildManageTourneyPlayersSnapshot = ({ config = {}, playerRows = [] }) => {
  const capacityPlayers = playerRows
    .filter((player) => player.status === "approved")
    .map(mapPlayer);
  return {
    players: playerRows.map(managePlayer),
    capacity: buildTourneyRoleCapacitySnapshot({
      config: {
        teamCount:
          config.team_count || config.teamCount || TOURNEY_DEFAULT_TEAM_COUNT,
        updatedAt: config.updated_at || config.updatedAt || "",
        updatedBy: config.updated_by || config.updatedBy || "",
      },
      players: capacityPlayers,
    }),
  };
};

export async function getManageTourneyPlayersSnapshot({
  env = process.env,
} = {}) {
  if (isMemoryMode(env)) {
    return buildManageTourneyPlayersSnapshot({
      config: getMemoryRegistrationConfig(),
      playerRows: [...MEMORY_STORE.players].sort((left, right) =>
        String(left.created_at || left.createdAt || "").localeCompare(
          String(right.created_at || right.createdAt || "")
        )
      ),
    });
  }
  const snapshot = await readManageTourneyPlayersSnapshot(env);
  return buildManageTourneyPlayersSnapshot({
    config: snapshot.config,
    playerRows: Array.isArray(snapshot.players) ? snapshot.players : [],
  });
}

const getRoleCapacity = (snapshot, rolePlay) =>
  snapshot.roles.find((role) => role.role === rolePlay) || null;

const TOURNEY_REGISTRATION_CAPACITY_LOCK_KEY =
  "roo-tourney-registration-decisions";

const lockTourneyRegistrationCapacity = async ({ sql }) => {
  await sql`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${TOURNEY_REGISTRATION_CAPACITY_LOCK_KEY}, 0)
    )
  `;
};

const runTourneyRegistrationCapacityTransaction = ({
  env = process.env,
  callback,
} = {}) => runTourneyTransaction({
  env,
  lockKey: TOURNEY_REGISTRATION_CAPACITY_LOCK_KEY,
  waitForLock: true,
  callback: async (sql) => {
    await lockTourneyRegistrationCapacity({ sql });
    return callback(sql);
  },
});

const roleCapacityError = ({ role, snapshot }) => Object.assign(
  new Error(`${role || "The selected role"} has no open main-player slots.`),
  {
    code: "TOURNEY_ROLE_CAPACITY_FULL",
    status: 409,
    capacity: role ? getRoleCapacity(snapshot, role) : null,
    capacitySnapshot: snapshot,
  }
);

const isRoleCapacityFullForRegistration = ({ roleCapacity, value }) => {
  if (!roleCapacity) return false;
  if (isFroggerReservedRegistration(value)) {
    return roleCapacity.reservedIsFull;
  }
  return roleCapacity.isFull;
};

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
  authUserId = "",
  preparedPasswordHash = "",
  env = process.env,
} = {}) {
  const validation = validateTourneyPlayerPayload(payload, {
    allowPasswordless: Boolean(authUserId),
    requireAgreements: true,
  });
  if (!validation.ok) {
    throw Object.assign(new Error(validation.errors[0] || "Invalid registration."), {
      status: 400,
      errors: validation.errors,
    });
  }

  const value = validation.value;
  await assertNoDuplicatePlayer({ value, env });

  const id = crypto.randomUUID();
  const passwordHash = preparedPasswordHash || await createTourneyPasswordHash({
    allowGenerated: true,
    password: value.password,
  });
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
    secondary_role_play: value.secondaryRolePlay,
    approved_role_play: "",
    registration_pool: "main",
    time_zone: value.timezone,
    twitch_username: value.twitchUsername,
    team_name: value.teamName,
    available_aug_1_2: value.availableAug12,
    accepted_rules: value.acceptedRules,
    accepted_roo_visibility: value.acceptedRooVisibility,
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
        expires_at: APPROVAL_TOKEN_NO_EXPIRES_AT,
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
        discord_key, battlenet, rank_name, role_play, secondary_role_play,
        approved_role_play, registration_pool,
        time_zone, twitch_username, team_name, available_aug_1_2,
        accepted_rules, accepted_roo_visibility, notes,
        version, created_at, updated_at
      )
      values (
        ${playerRow.id}, ${playerRow.username}, ${playerRow.email},
        ${playerRow.password_hash}, ${playerRow.status}, ${playerRow.discord},
        ${playerRow.display_name}, ${playerRow.discord_key}, ${playerRow.battlenet}, ${playerRow.rank_name},
        ${playerRow.role_play}, ${playerRow.secondary_role_play}, ${playerRow.approved_role_play},
        ${playerRow.registration_pool}, ${playerRow.time_zone}, ${playerRow.twitch_username},
        ${playerRow.team_name}, ${playerRow.available_aug_1_2},
        ${playerRow.accepted_rules}, ${playerRow.accepted_roo_visibility},
        ${playerRow.notes}, ${playerRow.version},
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
    await syncTourneyPlayerAuth({
      installPassword: Boolean(value.password),
      playerRow,
      authUserId,
      env,
    });
  } catch (error) {
    if (authUserId || isSupabaseTourneyDatabase(env)) {
      await sql`delete from tourney_players where id = ${playerRow.id}`.catch(
        () => {}
      );
    }
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
  preparedPasswordHash = "",
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
  const id = crypto.randomUUID();
  const passwordHash = preparedPasswordHash || await createTourneyPasswordHash({
    password: value.password,
  });
  const createdAt = nowIso();
  const buildPlayerRow = (registrationPool) => ({
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
    secondary_role_play: value.secondaryRolePlay,
    approved_role_play: value.rolePlay,
    registration_pool: registrationPool,
    time_zone: value.timezone,
    twitch_username: value.twitchUsername,
    team_name: value.teamName,
    available_aug_1_2: value.availableAug12,
    accepted_rules: value.acceptedRules,
    accepted_roo_visibility: value.acceptedRooVisibility,
    notes: value.notes,
    version: 1,
    created_at: createdAt,
    updated_at: createdAt,
    approved_at: createdAt,
    approved_by: normalizeTourneyUsername(actorUsername),
  });

  const resolveRegistrationPool = async () => {
    let registrationPool = value.registrationPool;
    if (normalizeRegistrationPool(registrationPool) === "main") {
      const capacitySnapshot = await getTourneyRoleCapacitySnapshot({ env });
      const roleCapacity = getRoleCapacity(capacitySnapshot, value.rolePlay);
      if (isRoleCapacityFullForRegistration({ roleCapacity, value })) {
        registrationPool = "substitute";
      }
    }
    return registrationPool;
  };

  if (isMemoryMode(env)) {
    await assertNoDuplicatePlayer({ value, env });
    const playerRow = buildPlayerRow(await resolveRegistrationPool());
    MEMORY_STORE.players.push(playerRow);
    return managePlayer(playerRow);
  }

  return runTourneyRegistrationCapacityTransaction({
    env,
    callback: async (sql) => {
      await assertNoDuplicatePlayer({ value, env });
      const playerRow = buildPlayerRow(await resolveRegistrationPool());
      await sql`
        insert into tourney_players (
          id, username, email, password_hash, status, discord, display_name,
          discord_key, battlenet, rank_name, role_play, secondary_role_play,
          approved_role_play, registration_pool,
          time_zone, twitch_username, team_name, available_aug_1_2,
          accepted_rules, accepted_roo_visibility, notes,
          version, created_at, updated_at, approved_at, approved_by
        )
        values (
          ${playerRow.id}, ${playerRow.username}, ${playerRow.email},
          ${playerRow.password_hash}, ${playerRow.status}, ${playerRow.discord},
          ${playerRow.display_name}, ${playerRow.discord_key}, ${playerRow.battlenet}, ${playerRow.rank_name},
          ${playerRow.role_play}, ${playerRow.secondary_role_play}, ${playerRow.approved_role_play},
          ${playerRow.registration_pool}, ${playerRow.time_zone}, ${playerRow.twitch_username},
          ${playerRow.team_name}, ${playerRow.available_aug_1_2},
          ${playerRow.accepted_rules}, ${playerRow.accepted_roo_visibility},
          ${playerRow.notes}, ${playerRow.version},
          ${playerRow.created_at}, ${playerRow.updated_at}, ${playerRow.approved_at},
          ${playerRow.approved_by}
        )
      `;
      await syncTourneyPlayerAuth({ playerRow, env });
      return managePlayer(playerRow);
    },
  });
}

export async function listApprovedTourneyPlayers({ env = process.env } = {}) {
  if (isMemoryMode(env)) {
    const players = MEMORY_STORE.players
      .filter((player) => player.status === "approved")
      .map(publicPlayer)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    return attachTwitchRosterMetadata(players, { env });
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select id, display_name, discord, role_play, approved_role_play,
      registration_pool, team_name, twitch_username
    from tourney_players
    where status = 'approved'
    order by lower(coalesce(nullif(display_name, ''), discord)) asc
  `;
  return attachTwitchRosterMetadata(rows.map(publicPlayer), { env });
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
    select id, username, email, status, discord, display_name, discord_key,
      battlenet, rank_name, role_play, secondary_role_play, approved_role_play,
      registration_pool, time_zone, twitch_username, team_name,
      available_aug_1_2, accepted_rules, accepted_roo_visibility, notes,
      version, created_at, updated_at, approved_at, approved_by, denied_at,
      denied_by, removed_at, removed_by, withdrawn_at, withdrawn_by,
      discord_invite_sent_at, discord_invite_email_id,
      discord_invite_last_error, discord_user_id, discord_oauth_username,
      discord_oauth_global_name, discord_linked_at, discord_role_assigned_at,
      discord_role_last_error
    from tourney_players
    order by created_at desc
  `;
  return rows.map(managePlayer);
}

export async function getManageTourneyPlayerById({
  playerId,
  env = process.env,
} = {}) {
  const id = normalizeText(playerId);
  if (!id) return null;
  if (isMemoryMode(env)) {
    const player = MEMORY_STORE.players.find((entry) => entry.id === id);
    return player ? managePlayer(player) : null;
  }
  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select id, username, email, status, discord, display_name, discord_key,
      battlenet, rank_name, role_play, secondary_role_play, approved_role_play,
      registration_pool, time_zone, twitch_username, team_name,
      available_aug_1_2, accepted_rules, accepted_roo_visibility, notes,
      version, created_at, updated_at, approved_at, approved_by, denied_at,
      denied_by, removed_at, removed_by, withdrawn_at, withdrawn_by,
      discord_invite_sent_at, discord_invite_email_id,
      discord_invite_last_error, discord_user_id, discord_oauth_username,
      discord_oauth_global_name, discord_linked_at, discord_role_assigned_at,
      discord_role_last_error
    from tourney_players
    where id = ${id}
    limit 1
  `;
  return rows?.[0] ? managePlayer(rows[0]) : null;
}

export async function listApprovedTourneyDiscordInviteRecipients({
  includeAlreadySent = false,
  onlyEmail = "",
  limit = 0,
  env = process.env,
} = {}) {
  const normalizedOnlyEmail = normalizeTourneyEmail(onlyEmail);
  const maxRows = Math.max(0, Number(limit) || 0);
  const filterRows = (rows) => {
    const filtered = rows
      .map(managePlayer)
      .filter((player) => player.status === "approved")
      .filter((player) =>
        normalizedOnlyEmail ? normalizeTourneyEmail(player.email) === normalizedOnlyEmail : true
      )
      .filter((player) => includeAlreadySent || !player.discordInviteSentAt)
      .sort((left, right) =>
        normalizeTourneyEmail(left.email).localeCompare(normalizeTourneyEmail(right.email))
      );
    return maxRows > 0 ? filtered.slice(0, maxRows) : filtered;
  };

  if (isMemoryMode(env)) {
    return filterRows(MEMORY_STORE.players);
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select id, username, email, status, discord, display_name, discord_key,
      battlenet, rank_name, role_play, secondary_role_play, approved_role_play,
      registration_pool, time_zone, twitch_username, team_name,
      available_aug_1_2, accepted_rules, accepted_roo_visibility, notes,
      version, created_at, updated_at, approved_at, approved_by, denied_at,
      denied_by, removed_at, removed_by, withdrawn_at, withdrawn_by,
      discord_invite_sent_at, discord_invite_email_id,
      discord_invite_last_error, discord_user_id, discord_oauth_username,
      discord_oauth_global_name, discord_linked_at, discord_role_assigned_at,
      discord_role_last_error
    from tourney_players
    where status = 'approved'
    order by lower(email) asc
  `;
  return filterRows(rows);
}

export async function getApprovedTourneyPlayerById({
  playerId,
  version = "",
  env = process.env,
} = {}) {
  const expectedVersion = String(version || "").trim();
  if (isMemoryMode(env)) {
    const row = MEMORY_STORE.players.find(
      (player) =>
        player.id === playerId &&
        player.status === "approved" &&
        (!expectedVersion || String(player.version || "1") === expectedVersion)
    );
    return row ? managePlayer(row) : null;
  }

  const expectedVersionNumber = expectedVersion ? Number(expectedVersion) : 0;
  if (expectedVersion && !Number.isInteger(expectedVersionNumber)) return null;

  const player = await getManageTourneyPlayerById({ playerId, env });
  if (!player || player.status !== "approved") return null;
  if (expectedVersion && Number(player.version) !== expectedVersionNumber) {
    return null;
  }
  return player;
}

export async function recordTourneyPlayerDiscordLink({
  playerId,
  discordUser = {},
  linkedAt = nowIso(),
  env = process.env,
} = {}) {
  const discordUserId = normalizeText(discordUser.id);
  if (!discordUserId) {
    throw Object.assign(new Error("Discord user id is required."), { status: 400 });
  }
  const username = normalizeText(discordUser.username).slice(0, 120);
  const globalName = normalizeText(discordUser.global_name).slice(0, 120);

  if (isMemoryMode(env)) {
    const player = MEMORY_STORE.players.find(
      (entry) => entry.id === playerId && entry.status === "approved"
    );
    if (!player) return null;
    player.discord_user_id = discordUserId;
    player.discord_oauth_username = username;
    player.discord_oauth_global_name = globalName;
    player.discord_linked_at = linkedAt;
    player.discord_role_last_error = "";
    return managePlayer(player);
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    update tourney_players
    set discord_user_id = ${discordUserId},
        discord_oauth_username = ${username},
        discord_oauth_global_name = ${globalName},
        discord_linked_at = ${linkedAt},
        discord_role_last_error = ''
    where id = ${playerId}
      and status = 'approved'
    returning *
  `;
  return rows?.[0] ? managePlayer(rows[0]) : null;
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
    if (
      player.status === "approved" &&
      normalizeRegistrationPool(player.registration_pool) !== "main" &&
      value.registrationPool === "main"
    ) {
      const snapshot = await getTourneyRoleCapacitySnapshot({ env });
      const role = getEffectiveRolePlay(player);
      const roleCapacity = getRoleCapacity(snapshot, role);
      if (isRoleCapacityFullForRegistration({ roleCapacity, value: mapPlayer(player) })) {
        throw roleCapacityError({ role, snapshot });
      }
    }
    player.display_name = value.displayName;
    player.twitch_username = value.twitchUsername;
    player.team_name = value.teamName;
    player.registration_pool = value.registrationPool;
    player.updated_at = now;
    player.updated_by = actor;
    player.version = Number(player.version || 1) + 1;
    return managePlayer(player);
  }

  return runTourneyRegistrationCapacityTransaction({
    env,
    callback: async (sql) => {
      const currentRows = await sql`
        select * from tourney_players where id = ${playerId} for update
      `;
      const current = currentRows[0];
      if (!current) {
        throw Object.assign(new Error("Player not found."), { status: 404 });
      }
      if (
        current.status === "approved" &&
        normalizeRegistrationPool(current.registration_pool) !== "main" &&
        value.registrationPool === "main"
      ) {
        const snapshot = await getTourneyRoleCapacitySnapshot({ env });
        const role = getEffectiveRolePlay(current);
        const roleCapacity = getRoleCapacity(snapshot, role);
        if (
          isRoleCapacityFullForRegistration({
            roleCapacity,
            value: mapPlayer(current),
          })
        ) {
          throw roleCapacityError({ role, snapshot });
        }
      }
      const rows = await sql`
        update tourney_players
        set display_name = ${value.displayName},
            twitch_username = ${value.twitchUsername},
            team_name = ${value.teamName},
            registration_pool = ${value.registrationPool},
            updated_at = ${now},
            version = version + 1
        where id = ${playerId}
        returning *
      `;
      if (!rows?.[0]) {
        throw Object.assign(new Error("Player not found."), { status: 404 });
      }
      await syncTourneyPlayerAuth({ playerRow: rows[0], env });
      return managePlayer(rows[0]);
    },
  });
}

export async function updateTourneyPlayerApprovedRole({
  playerId,
  rolePlay,
  actorUsername,
  env = process.env,
} = {}) {
  const selectedRole = normalizeRolePlay(rolePlay);
  if (!TOURNEY_ROLE_PLAYS.includes(selectedRole)) {
    throw Object.assign(new Error("Choose a valid role."), { status: 400 });
  }

  const actor = normalizeTourneyUsername(actorUsername);
  const now = nowIso();

  if (isMemoryMode(env)) {
    const player = MEMORY_STORE.players.find((entry) => entry.id === playerId);
    if (!player || player.status !== "approved") {
      throw Object.assign(new Error("Only approved players can have roles changed."), {
        status: 400,
      });
    }
    if (
      normalizeRegistrationPool(player.registration_pool) === "main" &&
      getEffectiveRolePlay(player) !== selectedRole
    ) {
      const snapshot = await getTourneyRoleCapacitySnapshot({ env });
      const roleCapacity = getRoleCapacity(snapshot, selectedRole);
      const projected = mapPlayer({
        ...player,
        approved_role_play: selectedRole,
      });
      if (isRoleCapacityFullForRegistration({ roleCapacity, value: projected })) {
        throw roleCapacityError({ role: selectedRole, snapshot });
      }
    }
    player.approved_role_play = selectedRole;
    if (!getSubmittedRolePlays(player).includes(selectedRole)) {
      player.role_play = selectedRole;
      if (player.secondary_role_play === selectedRole) {
        player.secondary_role_play = "";
      }
    }
    player.updated_at = now;
    player.updated_by = actor;
    player.version = Number(player.version || 1) + 1;
    return managePlayer(player);
  }

  return runTourneyRegistrationCapacityTransaction({
    env,
    callback: async (sql) => {
      const currentRows = await sql`
        select * from tourney_players
        where id = ${playerId} and status = 'approved'
        for update
      `;
      const current = currentRows[0];
      if (!current) {
        throw Object.assign(
          new Error("Only approved players can have roles changed."),
          { status: 400 }
        );
      }
      if (
        normalizeRegistrationPool(current.registration_pool) === "main" &&
        getEffectiveRolePlay(current) !== selectedRole
      ) {
        const snapshot = await getTourneyRoleCapacitySnapshot({ env });
        const roleCapacity = getRoleCapacity(snapshot, selectedRole);
        const projected = mapPlayer({
          ...current,
          approved_role_play: selectedRole,
        });
        if (isRoleCapacityFullForRegistration({ roleCapacity, value: projected })) {
          throw roleCapacityError({ role: selectedRole, snapshot });
        }
      }
      const rows = await sql`
        update tourney_players
        set approved_role_play = ${selectedRole},
            role_play = case
              when role_play = ${selectedRole} or secondary_role_play = ${selectedRole}
                then role_play
              else ${selectedRole}
            end,
            updated_at = ${now},
            version = version + 1
        where id = ${playerId}
          and status = 'approved'
        returning *
      `;
      if (!rows?.[0]) {
        throw Object.assign(
          new Error("Only approved players can have roles changed."),
          { status: 400 }
        );
      }
      await syncTourneyPlayerAuth({ playerRow: rows[0], env });
      return managePlayer(rows[0]);
    },
  });
}

export async function getRegistrationDecisionToken({
  token,
  purpose,
  allowUsed = false,
  env = process.env,
} = {}) {
  if (!["approve", "deny"].includes(purpose)) return null;

  const hashed = tokenHash(token);

  if (isMemoryMode(env)) {
    const row = MEMORY_STORE.tokens.find(
      (entry) =>
        entry.token_hash === hashed &&
        entry.purpose === purpose &&
        (allowUsed || !entry.used_at)
    );
    return row ? { ...row } : null;
  }

  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const rows = await sql`
    select id, player_id, token_hash, purpose, recipient_username,
      recipient_email, recipient_role, recipient_version, expires_at,
      used_at, used_by, created_at
    from tourney_player_tokens
    where token_hash = ${hashed}
      and purpose = ${purpose}
      and (${allowUsed} or used_at is null)
    limit 1
  `;
  return rows?.[0] || null;
}

export async function applyRegistrationDecision({
  tokenHash,
  playerId,
  purpose,
  actorUsername,
  approvedRolePlay = "",
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
    const selectedApprovedRole =
      status === "approved" ? resolveApprovedRolePlay(player, approvedRolePlay) : "";
    if (
      status === "approved" &&
      normalizeRegistrationPool(player.registration_pool || player.registrationPool) ===
        "main"
    ) {
      const capacitySnapshot = await getTourneyRoleCapacitySnapshot({ env });
      const roleCapacity = getRoleCapacity(capacitySnapshot, selectedApprovedRole);
      const isFull = isRoleCapacityFullForRegistration({
        roleCapacity,
        value: mapPlayer({ ...player, approved_role_play: selectedApprovedRole }),
      });
      if (isFull) {
        player.registration_pool = "substitute";
      }
    }
    player.status = status;
    player.version = Number(player.version || 1) + 1;
    player.updated_at = now;
    if (status === "approved") {
      player.approved_role_play = selectedApprovedRole;
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

  if (isSupabaseTourneyDatabase(env)) {
    const claimed = await claimSupabaseRegistrationDecision({
      playerId,
      tokenHash,
      purpose,
      actorUsername: actor,
      env,
      resolveDecision: async ({ player, reservations }) => {
        const selectedApprovedRole =
          status === "approved"
            ? resolveApprovedRolePlay(player, approvedRolePlay)
            : "";
        let registrationPool = player.registration_pool || "main";
        if (
          status === "approved" &&
          normalizeRegistrationPool(registrationPool) === "main"
        ) {
          const snapshot = await getTourneyRoleCapacitySnapshot({ env });
          const roleCapacity = getRoleCapacity(snapshot, selectedApprovedRole);
          const reservedForRole = (reservations || []).filter((entry) => {
            const payload = entry.operation_payload || {};
            return (
              payload.approvedRolePlay === selectedApprovedRole &&
              normalizeRegistrationPool(payload.registrationPool) === "main"
            );
          }).length;
          const isFull = isRoleCapacityFullForRegistration({
            roleCapacity: roleCapacity
              ? {
                  ...roleCapacity,
                  isFull: roleCapacity.mainCount + reservedForRole >= roleCapacity.cap,
                }
              : null,
            value: mapPlayer({
              ...player,
              approved_role_play: selectedApprovedRole,
            }),
          });
          if (isFull) registrationPool = "substitute";
        }
        return {
          status,
          approvedRolePlay: selectedApprovedRole,
          registrationPool,
        };
      },
    });

    if (claimed.completed) {
      return { ...managePlayer(claimed.player), decisionTransitioned: false };
    }
    if (claimed.authApplied) {
      await syncTourneyPlayerAuth({ playerRow: claimed.player, env });
      await completeSupabaseAuthOperation({
        operationKey: claimed.operation.key,
        env,
      });
      return { ...managePlayer(claimed.player), decisionTransitioned: false };
    }

    const finalized = await finalizeSupabaseRegistrationDecision({
      operation: claimed.operation,
      env,
    });
    await syncTourneyPlayerAuth({ playerRow: finalized, env });
    await completeSupabaseAuthOperation({
      operationKey: claimed.operation.key,
      env,
    });
    return { ...managePlayer(finalized), decisionTransitioned: true };
  }

  return runTourneyRegistrationCapacityTransaction({
    env,
    callback: async (sql) => {
      const pendingRows = await sql`
        select id, username, email, password_hash, status, discord, display_name,
          discord_key, battlenet, rank_name, role_play, secondary_role_play,
          approved_role_play, registration_pool, time_zone, twitch_username,
          team_name, available_aug_1_2, accepted_rules,
          accepted_roo_visibility, notes, version, created_at, updated_at,
          approved_at, approved_by, denied_at, denied_by, removed_at, removed_by,
          withdrawn_at, withdrawn_by, discord_invite_sent_at,
          discord_invite_email_id, discord_invite_last_error, discord_user_id,
          discord_oauth_username, discord_oauth_global_name, discord_linked_at,
          discord_role_assigned_at, discord_role_last_error
        from tourney_players
        where id = ${playerId}
          and status = 'pending'
        limit 1
        for update
      `;
      const pendingPlayer = pendingRows?.[0];
      if (!pendingPlayer) {
        throw Object.assign(new Error("Registration is no longer pending."), {
          status: 409,
        });
      }

      const selectedApprovedRole =
        status === "approved"
          ? resolveApprovedRolePlay(pendingPlayer, approvedRolePlay)
          : "";
      let nextRegistrationPool = pendingPlayer.registration_pool || "main";
      if (
        status === "approved" &&
        normalizeRegistrationPool(nextRegistrationPool) === "main"
      ) {
        const capacitySnapshot = await getTourneyRoleCapacitySnapshot({ env });
        const roleCapacity = getRoleCapacity(capacitySnapshot, selectedApprovedRole);
        const isFull = isRoleCapacityFullForRegistration({
          roleCapacity,
          value: mapPlayer({
            ...pendingPlayer,
            approved_role_play: selectedApprovedRole,
          }),
        });
        if (isFull) {
          nextRegistrationPool = "substitute";
        }
      }

      const rows =
        status === "approved"
          ? await sql`
              update tourney_players
              set status = 'approved',
                  approved_role_play = ${selectedApprovedRole},
                  registration_pool = ${nextRegistrationPool},
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

      await syncTourneyPlayerAuth({ playerRow: player, env });
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
    },
  });
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

  return runTourneyRegistrationCapacityTransaction({
    env,
    callback: async (sql) => {
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
      await syncTourneyPlayerAuth({ playerRow: rows[0], env });
      return managePlayer(rows[0]);
    },
  });
}

export async function withdrawTourneyPlayer({
  playerId,
  actorUsername,
  env = process.env,
} = {}) {
  const actor = normalizeTourneyUsername(actorUsername);
  const now = nowIso();

  if (isMemoryMode(env)) {
    const player = MEMORY_STORE.players.find((entry) => entry.id === playerId);
    if (!player || player.status !== "approved") {
      throw Object.assign(new Error("Only approved players can opt out."), {
        status: 400,
      });
    }
    player.status = "withdrawn";
    player.version = Number(player.version || 1) + 1;
    player.updated_at = now;
    player.withdrawn_at = now;
    player.withdrawn_by = actor;
    return managePlayer(player);
  }

  return runTourneyRegistrationCapacityTransaction({
    env,
    callback: async (sql) => {
      const rows = await sql`
        update tourney_players
        set status = 'withdrawn',
            withdrawn_at = ${now},
            withdrawn_by = ${actor},
            updated_at = ${now},
            version = version + 1
        where id = ${playerId}
          and status = 'approved'
        returning *
      `;
      if (!rows?.[0]) {
        throw Object.assign(new Error("Only approved players can opt out."), {
          status: 400,
        });
      }
      await syncTourneyPlayerAuth({ playerRow: rows[0], env });
      return managePlayer(rows[0]);
    },
  });
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
      select id, principal_id, username, status, version, password_hash
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
      principalId: player.principalId,
      playerId: player.id,
      authBackend: isSupabaseTourneyDatabase(env) ? "supabase" : "legacy",
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
    select id, principal_id, username, status, version, display_name, discord, email,
      role_play, secondary_role_play, approved_role_play, registration_pool,
      twitch_username, team_name
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
      recipient_version: String(player.version || "1"),
      expires_at: expiresAt,
      created_at: now,
    });
    return { player: managePlayer(player), token: plainToken, expiresAt };
  }

  if (!getDatabaseUrl(env)) return null;
  await ensureTourneyPlayerSchema(env);
  const sql = await getSql(env);
  const players = await sql`
    select id, username, email, status, discord, display_name, version
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
      id, player_id, token_hash, purpose, recipient_version, expires_at, created_at
    )
    values (
      ${crypto.randomUUID()}, ${player.id}, ${hashed}, 'reset',
      ${String(player.version || "1")}, ${expiresAt}, ${now}
    )
  `;
  return { player: managePlayer(player), token: plainToken, expiresAt };
}

export async function resetTourneyPlayerPassword({
  token,
  password,
  preparedPasswordHash = "",
  env = process.env,
} = {}) {
  if (String(password || "").length < 8) {
    throw Object.assign(new Error("Password must be at least 8 characters."), {
      status: 400,
    });
  }

  const hashedToken = tokenHash(token);
  const passwordHash = preparedPasswordHash || await createTourneyPasswordHash({ password });
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
    if (String(resetToken.recipient_version || "") !== String(player.version || "1")) {
      throw Object.assign(new Error("Invalid or expired reset link."), { status: 400 });
    }
    player.password_hash = passwordHash;
    player.version = Number(player.version || 1) + 1;
    player.updated_at = now;
    for (const entry of MEMORY_STORE.tokens) {
      if (entry.player_id === player.id && entry.purpose === "reset" && !entry.used_at) {
        entry.used_at = now;
        entry.used_by = player.username;
      }
    }
    return managePlayer(player);
  }

  if (isSupabaseTourneyDatabase(env)) {
    const claimed = await claimSupabasePasswordReset({
      tokenHash: hashedToken,
      password,
      passwordHash,
      env,
    });
    if (claimed.completed) return managePlayer(claimed.player);
    if (claimed.authApplied) {
      await syncTourneyPlayerAuth({ playerRow: claimed.player, env });
      await completeSupabaseAuthOperation({
        operationKey: claimed.operation.key,
        env,
      });
      return managePlayer(claimed.player);
    }

    const finalized = await finalizeSupabasePasswordReset({
      operation: claimed.operation,
      env,
    });
    await syncTourneyPlayerAuth({ playerRow: finalized, env });
    await completeSupabaseAuthOperation({
      operationKey: claimed.operation.key,
      env,
    });
    return managePlayer(finalized);
  }

  await ensureTourneyPlayerSchema(env);
  const updated = await runTourneyTransaction({
    env,
    lockKey: `roo-tourney-password-reset:${hashedToken}`,
    waitForLock: true,
    callback: async (sql) => {
      const tokens = await sql`
        select id, player_id, recipient_version, used_at, expires_at
        from tourney_player_tokens
        where token_hash = ${hashedToken} and purpose = 'reset'
        limit 1 for update
      `;
      const resetToken = tokens?.[0];
      if (!resetToken || resetToken.used_at || Date.parse(resetToken.expires_at) <= Date.now()) {
        throw Object.assign(new Error("Invalid or expired reset link."), { status: 400 });
      }
      const players = await sql`
        select * from tourney_players
        where id = ${resetToken.player_id} and status = 'approved'
        for update
      `;
      const player = players?.[0];
      if (!player || String(resetToken.recipient_version || "") !== String(player.version || "1")) {
        throw Object.assign(new Error("Invalid or expired reset link."), { status: 400 });
      }
      const rows = await sql`
        update tourney_players
        set password_hash = ${passwordHash}, updated_at = ${now}, version = version + 1
        where id = ${player.id} and status = 'approved' and version = ${Number(player.version)}
        returning *
      `;
      if (!rows?.[0]) {
        throw Object.assign(new Error("Invalid or expired reset link."), { status: 400 });
      }
      await sql`
        update tourney_player_tokens
        set used_at = ${now}, used_by = ${rows[0].username}
        where player_id = ${player.id} and purpose = 'reset' and used_at is null
      `;
      return rows[0];
    },
  });
  await syncTourneyPlayerAuth({
    playerRow: { ...updated, password_hash: passwordHash },
    env,
  });
  return managePlayer(updated);
}
