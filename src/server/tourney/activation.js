import crypto from "node:crypto";
import { readEffectiveTourneyAccounts, renderTourneyAccountsJson } from "./auth.js";
import { writePersistedTourneyAccountsJson } from "./accountStore.js";
import { getTourneyDiscordRoleConfig } from "./discordConfig.js";
import { recordTourneyDiscordDesiredState } from "./discordDesiredState.js";
import { enqueueTourneyExternalOperation } from "./externalOperations.js";
import { listManageTourneyPlayers } from "./playerStore.js";
import { getTourneySql, getTourneySqlForBackend } from "./sqlClient.js";
import { executeTourneyCommand, resolveTourneyStorePolicy } from "./store.js";
import { isEnabledTourneyFlag, stableTourneyJson } from "./canonical.js";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const requireActivationPolicy = (env) => {
  const policy = resolveTourneyStorePolicy(env);
  const valid = policy.primaryBackend === "supabase" && policy.mirrorEnabled &&
    policy.writesPaused && policy.generation === 1 &&
    isEnabledTourneyFlag(env.TOURNEY_HARDENING_V4_ENABLED);
  if (!valid) {
    const error = new Error("Tourney activation controls are not ready.");
    error.code = "TOURNEY_ACTIVATION_CONTROL_MISMATCH";
    error.status = 409;
    throw error;
  }
  return policy;
};

const discordRetryDelay = async (response) => {
  const headerValue = String(response.headers?.get?.("retry-after") ?? "").trim();
  const headerSeconds = headerValue ? Number(headerValue) : Number.NaN;
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return Math.min(60_000, Math.ceil(headerSeconds * 1_000) + 50);
  }
  const body = await response.json().catch(() => ({}));
  const bodySeconds = Number(body?.retry_after);
  return Number.isFinite(bodySeconds) && bodySeconds >= 0
    ? Math.min(60_000, Math.ceil(bodySeconds * 1_000) + 50)
    : 1_000;
};

const readDiscordMember = async ({
  config,
  discordUserId,
  fetchImpl,
  sleepImpl,
}) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetchImpl(
        `${config.apiBaseUrl}/guilds/${config.guildId}/members/${discordUserId}`,
        {
          headers: { Authorization: `Bot ${config.botToken}` },
          signal: AbortSignal.timeout(5_000),
        }
      );
      if (response.status === 429 && attempt < 3) {
        await sleepImpl(await discordRetryDelay(response));
        continue;
      }
      if (response.status >= 500 && attempt < 3) {
        await sleepImpl(250 * (attempt + 1));
        continue;
      }
      if (response.status === 404) return { membership: "absent", managedRoles: [] };
      if (!response.ok) return { membership: "unknown", managedRoles: [] };
      const member = await response.json();
      const roles = new Set(Array.isArray(member.roles) ? member.roles.map(String) : []);
      return {
        membership: "present",
        managedRoles: [
          ...(roles.has(config.participantRoleId) ? ["participant"] : []),
          ...(roles.has(config.hostRoleId) ? ["host"] : []),
        ],
      };
    } catch {
      if (attempt < 3) {
        await sleepImpl(250 * (attempt + 1));
        continue;
      }
    }
  }
  return { membership: "unknown", managedRoles: [] };
};

const readActivationRows = async ({ env }) => {
  const [accounts, players, sql, legacySql] = await Promise.all([
    readEffectiveTourneyAccounts({ env }),
    listManageTourneyPlayers({ env }),
    getTourneySql(env),
    getTourneySqlForBackend({ backend: "legacy", env }),
  ]);
  const [[databaseState], [legacyControl]] = await Promise.all([sql`
    select
      (select primary_backend from tourney.cutover_metadata where id='tourney') primary_backend,
      (select generation from tourney.cutover_metadata where id='tourney') generation,
      (select writes_paused from tourney.cutover_metadata where id='tourney') writes_paused,
      (select hardened_active from tourney.cutover_metadata where id='tourney') hardened_active,
      (select count(*)::integer from tourney.identity_conflicts
        where resolved_at is null) identity_conflicts,
      (select count(*)::integer from migration.tourney_import_quarantine
        where resolved_at is null) ambiguous_imports,
      (select count(*)::integer from tourney.tourney_players player
        join accounts.tourney_accounts account on account.legacy_sanity_id=player.id
        where account.principal_id is not null
          and player.principal_id is distinct from account.principal_id) principal_mismatches,
      (select count(*)::integer from tourney.tourney_players player
        left join accounts.tourney_accounts account on account.legacy_sanity_id=player.id
        where player.status='approved' and account.principal_id is null) missing_principals,
      (select count(*)::integer from (
        select discord_user_id from tourney.tourney_players
        where status='approved' and discord_user_id is not null
        group by discord_user_id having count(*) > 1
      ) duplicates) duplicate_discord_users
  `, legacySql`
    select primary_backend, generation, writes_paused, hardened_active
    from tourney_cutover_metadata where id='tourney'
  `]);
  return {
    accounts,
    databaseState: { ...databaseState, legacyControl },
    players: players.filter((player) => player.status === "approved" && player.discordUserId),
  };
};

const summarizeInventory = ({ accounts, databaseState, rows }) => ({
  accounts: accounts.length,
  linked: rows.length,
  present: rows.filter((row) => row.membership === "present").length,
  blockedReauth: rows.filter((row) => row.membership === "absent").length,
  unknown: rows.filter((row) => row.membership === "unknown").length,
  conflicts: rows.filter((row) => row.managedRoles.length > 1).length,
  needsRepair: rows.filter((row) =>
    row.membership === "present" &&
    (row.managedRoles.length !== 1 || row.managedRoles[0] !== row.desiredRole)
  ).length,
  principalMismatches: Number(databaseState?.principal_mismatches || 0),
  missingPrincipals: Number(databaseState?.missing_principals || 0),
  duplicateDiscordUsers: Number(databaseState?.duplicate_discord_users || 0),
  identityConflicts: Number(databaseState?.identity_conflicts || 0),
  ambiguousImports: Number(databaseState?.ambiguous_imports || 0),
  databaseControlsReady: [databaseState, databaseState?.legacyControl].every(
    (control) => control?.primary_backend === "supabase" &&
      Number(control?.generation) === 1 && control?.writes_paused === true &&
      control?.hardened_active === true
  ),
});

export const inventoryTourneyV4Activation = async ({
  env = process.env,
  fetchImpl = fetch,
  sleepImpl = sleep,
} = {}) => {
  requireActivationPolicy(env);
  const local = await readActivationRows({ env });
  const config = getTourneyDiscordRoleConfig(env);
  if (!config.enabled) {
    const error = new Error("Tourney Discord reconciliation is not configured.");
    error.code = "TOURNEY_DISCORD_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }
  const rows = [];
  for (const player of local.players) {
    rows.push({
      playerId: player.id,
      discordUserId: player.discordUserId,
      desiredRole: "participant",
      ...(await readDiscordMember({
        config,
        discordUserId: player.discordUserId,
        fetchImpl,
        sleepImpl,
      })),
    });
  }
  rows.sort((left, right) => left.playerId.localeCompare(right.playerId));
  const evidence = {
    accountsHash: sha256(renderTourneyAccountsJson(local.accounts)),
    databaseState: local.databaseState,
    rows,
  };
  return {
    dryRun: true,
    contactedDiscord: true,
    inventoryHash: sha256(stableTourneyJson(evidence)),
    counts: summarizeInventory({ ...local, rows }),
  };
};

export const seedTourneyAccountSnapshotV4 = async ({ env = process.env } = {}) => {
  const accounts = await readEffectiveTourneyAccounts({ env });
  if (accounts.length === 0) throw new Error("Tourney account snapshot is missing.");
  const sql = await getTourneySql(env);
  const mappings = await sql`
    select username,principal_id from accounts.tourney_accounts
    where principal_id is not null
  `;
  const principalByUsername = new Map(
    mappings.map((mapping) => [String(mapping.username).toLowerCase(), mapping.principal_id])
  );
  const enrichedAccounts = accounts.map((account) => ({
    ...account,
    ...(principalByUsername.get(String(account.username || "").toLowerCase())
      ? { principalId: principalByUsername.get(String(account.username || "").toLowerCase()) }
      : {}),
  }));
  const accountsJson = renderTourneyAccountsJson(enrichedAccounts);
  const commandId = `account-snapshot:seed:${sha256(accountsJson).slice(0, 32)}`;
  const result = await executeTourneyCommand({
    commandId,
    purpose: "accounts:seed",
    requestPayload: { canonicalHash: commandId.split(":").at(-1) },
    maintenanceWhilePaused: true,
    env,
    callback: async () => ({
      body: await writePersistedTourneyAccountsJson({
        accountsJson,
        actorUsername: "schema-v4-activation",
        env,
      }),
    }),
  });
  return { seeded: true, commandId, syncPending: Boolean(result.syncPending) };
};

export const seedTourneyPlayerPrincipalsV4 = async ({ env = process.env } = {}) => {
  const sql = await getTourneySql(env);
  const mappings = await sql`
    select player.id as player_id, account.principal_id
    from tourney.tourney_players player
    join accounts.tourney_accounts account on account.legacy_sanity_id=player.id
    where account.principal_id is not null
      and player.principal_id is distinct from account.principal_id
    order by player.id
  `;
  for (const mapping of mappings) {
    const commandId = `principal-seed:${mapping.player_id}:${mapping.principal_id}`;
    await executeTourneyCommand({
      commandId,
      purpose: "identity:principal-seed",
      requestPayload: { playerId: mapping.player_id, principalId: mapping.principal_id },
      maintenanceWhilePaused: true,
      env,
      callback: async () => {
        const transactionSql = await getTourneySql(env);
        await transactionSql`
          update tourney.tourney_players set principal_id=${mapping.principal_id}
          where id=${mapping.player_id}
        `;
        return { body: { ok: true } };
      },
    });
  }
  return { seeded: mappings.length };
};

export const seedTourneyDiscordDesiredStateV4 = async ({ env = process.env } = {}) => {
  const config = getTourneyDiscordRoleConfig(env);
  if (!config.enabled) throw new Error("Tourney Discord reconciliation is not configured.");
  const policy = resolveTourneyStorePolicy(env);
  const players = (await listManageTourneyPlayers({ env })).filter(
    (player) => player.status === "approved" && player.discordUserId
  );
  for (const player of players) {
    const commandId = [
      "discord-state-seed",
      `g${policy.generation}`,
      "v2",
      player.id,
      player.discordUserId,
    ].join(":");
    await executeTourneyCommand({
      commandId,
      purpose: "discord:backfill",
      requestPayload: { playerId: player.id, discordUserId: player.discordUserId },
      attemptExternalWork: false,
      maintenanceWhilePaused: true,
      env,
      callback: async () => {
        const sql = await getTourneySql(env);
        await sql`
          update tourney.external_operations set
            status='applied', completed_at=coalesce(completed_at,now()),
            lease_id=null, lease_expires_at=null,
            last_error_code='superseded_by_newer_desired_state', updated_at=now()
          where operation_kind='discord_role_reconcile'
            and entity_id=${player.id} and command_id<>${commandId}
            and status in ('pending','processing','retry','dead_letter')
        `;
        const assignment = await recordTourneyDiscordDesiredState({
          player,
          discordUser: { id: player.discordUserId },
          guildId: config.guildId,
          env,
        });
        await enqueueTourneyExternalOperation({
          commandId,
          operationKind: "discord_role_reconcile",
          entityType: "player",
          entityId: player.id,
          desiredState: { assignment: {
            principalId: assignment.principal_id,
            discordUserId: assignment.discord_user_id,
            previousDiscordUserId: assignment.previous_discord_user_id || "",
            desiredRole: assignment.desired_role,
            generation: Number(assignment.generation),
          } },
          env,
        });
        return { body: { ok: true } };
      },
    });
  }
  return { queued: players.length, contactedDiscord: false };
};

export const applyTourneyV4Activation = async ({
  env = process.env,
  fetchImpl = fetch,
  inventoryHash,
} = {}) => {
  requireActivationPolicy(env);
  const expectedHash = String(inventoryHash || "").trim();
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    const error = new Error("A valid activation inventory hash is required.");
    error.code = "TOURNEY_ACTIVATION_INVENTORY_REQUIRED";
    error.status = 400;
    throw error;
  }
  const inventory = await inventoryTourneyV4Activation({ env, fetchImpl });
  if (inventory.inventoryHash !== expectedHash || inventory.counts.unknown > 0 ||
      inventory.counts.accounts === 0 || inventory.counts.missingPrincipals > 0 ||
      inventory.counts.duplicateDiscordUsers > 0 || inventory.counts.identityConflicts > 0 ||
      inventory.counts.ambiguousImports > 0 || !inventory.counts.databaseControlsReady) {
    const error = new Error("Tourney activation inventory changed or is blocked.");
    error.code = "TOURNEY_ACTIVATION_INVENTORY_BLOCKED";
    error.status = 409;
    throw error;
  }
  const accountSnapshot = await seedTourneyAccountSnapshotV4({ env });
  const principals = await seedTourneyPlayerPrincipalsV4({ env });
  const discord = await seedTourneyDiscordDesiredStateV4({ env });
  return { applied: true, inventoryHash: expectedHash, accountSnapshot, principals, discord };
};
