import crypto from "node:crypto";
import { readEffectiveTourneyAccounts, renderTourneyAccountsJson } from "./auth.js";
import { writePersistedTourneyAccountsJson } from "./accountStore.js";
import { getTourneyDiscordRoleConfig } from "./discordConfig.js";
import { recordTourneyDiscordDesiredState } from "./discordDesiredState.js";
import { enqueueTourneyExternalOperation } from "./externalOperations.js";
import { getTourneySql, getTourneySqlForBackend } from "./sqlClient.js";
import { executeTourneyCommand, resolveTourneyStorePolicy } from "./store.js";
import { isEnabledTourneyFlag, stableTourneyJson } from "./canonical.js";
import { TOURNEY_MIRROR_CONTRACT } from "./mirrorContract.js";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const readActivationSourceAccounts = (env) => readEffectiveTourneyAccounts({
  env: { ...env, TOURNEY_HARDENING_V4_ENABLED: "0" },
});

const requireActivationPolicy = (env) => {
  const policy = resolveTourneyStorePolicy(env);
  const valid = policy.primaryBackend === "supabase" && policy.mirrorEnabled &&
    policy.writesPaused && policy.generation === 1 &&
    isEnabledTourneyFlag(env.TOURNEY_V4_ACTIVATION_ENABLED);
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

const readAuthoritativeDiscordPlayers = async ({ sql }) => {
  const rows = await sql`
    select player.id as player_id,
      player.principal_id as player_principal_id,
      player.discord_user_id as legacy_discord_user_id,
      account.principal_id as account_principal_id,
      account.active as account_active,
      identity.provider_subject as authoritative_discord_user_id
    from tourney.tourney_players player
    left join accounts.tourney_accounts account
      on account.legacy_sanity_id = player.id
     and account.role = 'tourney_player'
    left join accounts.identity_links identity
      on identity.principal_id = account.principal_id
     and identity.provider = 'discord'
    where player.status = 'approved'
      and (
        player.discord_user_id is not null
        or identity.provider_subject is not null
      )
    order by player.id
  `;
  const rowCounts = new Map();
  for (const row of rows) {
    const playerId = String(row.player_id || "").trim();
    rowCounts.set(playerId, (rowCounts.get(playerId) || 0) + 1);
  }
  return rows.map((row) => {
    const playerId = String(row.player_id || "").trim();
    const playerPrincipalId = String(row.player_principal_id || "").trim();
    const principalId = String(row.account_principal_id || "").trim();
    const legacyDiscordUserId = String(row.legacy_discord_user_id || "").trim();
    const discordUserId = String(row.authoritative_discord_user_id || "").trim();
    const conflictCode = (rowCounts.get(playerId) || 0) > 1
      ? "duplicate_principal_mapping"
      : !principalId
        ? "missing_principal"
        : row.account_active !== true
          ? "inactive_tourney_account"
        : playerPrincipalId && playerPrincipalId !== principalId
          ? "principal_mismatch"
          : !discordUserId
            ? "missing_authoritative_identity"
            : legacyDiscordUserId && legacyDiscordUserId !== discordUserId
              ? "legacy_identity_mismatch"
              : "";
    return {
      playerId,
      principalId,
      legacyDiscordUserId,
      discordUserId,
      conflictCode,
      verified: Boolean(discordUserId && !conflictCode),
    };
  });
};

const assertAuthoritativeDiscordPlayers = (players) => {
  const conflicts = players.filter((player) => !player.verified);
  if (conflicts.length === 0) return;
  const error = new Error("Tourney Discord identity authority is incomplete or inconsistent.");
  error.code = "TOURNEY_DISCORD_IDENTITY_AUTHORITY_CONFLICT";
  error.status = 409;
  error.evidence = {
    conflicts: conflicts.length,
    missing: conflicts.filter((player) =>
      ["missing_principal", "missing_authoritative_identity"].includes(player.conflictCode)
    ).length,
    mismatched: conflicts.filter((player) =>
      ["principal_mismatch", "legacy_identity_mismatch"].includes(player.conflictCode)
    ).length,
    inactiveTourneyAccounts: conflicts.filter((player) =>
      player.conflictCode === "inactive_tourney_account"
    ).length,
  };
  throw error;
};

const readActivationRows = async ({ env }) => {
  const [accounts, sql, legacySql] = await Promise.all([
    readActivationSourceAccounts(env),
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
      ) duplicates) duplicate_discord_users,
      (select count(*)::integer from tourney.mirror_outbox
        where status in ('pending','retry','processing','dead_letter')) mirror_blockers,
      (select count(*)::integer from tourney.external_operations
        where status in ('pending','retry','processing','dead_letter')) external_blockers,
      (select count(*)::integer from tourney.email_dispatches
        where status in ('pending','sending','retry','failed','dead_letter')) email_blockers,
      (select count(*)::integer from tourney.tourney_player_auth_operations
        where operation_status in ('pending','processing','auth_applied','retry')) auth_blockers,
      (select count(*)::integer from tourney.shadow_latency_baselines)
        latency_baselines
  `, legacySql`
    select primary_backend, generation, writes_paused, hardened_active
    from tourney_cutover_metadata where id='tourney'
  `]);
  const players = await readAuthoritativeDiscordPlayers({ sql });
  return {
    accounts,
    databaseState: { ...databaseState, legacyControl },
    players,
  };
};

const readRelationShape = async ({ sql, relation }) => {
  const rows = await sql`
    select attribute.attname::text column_name,
      pg_catalog.format_type(attribute.atttypid,attribute.atttypmod) data_type,
      attribute.attnotnull not_null,
      attribute.attidentity::text identity_kind,
      attribute.attgenerated::text generated_kind
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid=pg_catalog.to_regclass(${relation})
      and attribute.attnum>0 and not attribute.attisdropped
    order by attribute.attnum
  `;
  return rows.map((row) => ({
    column: row.column_name,
    type: row.data_type,
    notNull: row.not_null === true,
    identity: String(row.identity_kind || ""),
    generated: String(row.generated_kind || ""),
  }));
};

export const assertTourneyMirrorCatalogParityV4 = async ({ env = process.env } = {}) => {
  const [supabaseSql, legacySql] = await Promise.all([
    getTourneySqlForBackend({ backend: "supabase", env }),
    getTourneySqlForBackend({ backend: "legacy", env }),
  ]);
  for (const [logicalTable, contract] of Object.entries(TOURNEY_MIRROR_CONTRACT)) {
    const [supabaseShape, legacyShape] = await Promise.all([
      readRelationShape({ sql: supabaseSql, relation: contract.relations.supabase }),
      readRelationShape({ sql: legacySql, relation: contract.relations.legacy }),
    ]);
    const expected = [...contract.allowedColumns].sort();
    const supabaseColumns = supabaseShape.map((column) => column.column).sort();
    const legacyColumns = legacyShape.map((column) => column.column).sort();
    if (
      supabaseShape.length === 0 || legacyShape.length === 0 ||
      stableTourneyJson(supabaseColumns) !== stableTourneyJson(expected) ||
      stableTourneyJson(legacyColumns) !== stableTourneyJson(expected) ||
      stableTourneyJson(supabaseShape) !== stableTourneyJson(legacyShape)
    ) {
      const error = new Error(`Tourney mirror catalog drift detected for ${logicalTable}.`);
      error.code = "TOURNEY_MIRROR_CATALOG_DRIFT";
      error.status = 409;
      throw error;
    }
  }
  return { tables: Object.keys(TOURNEY_MIRROR_CONTRACT).length };
};

const summarizeInventory = ({ accounts, databaseState, rows }) => ({
  accounts: accounts.length,
  linked: rows.length,
  present: rows.filter((row) => row.membership === "present").length,
  blockedReauth: rows.filter((row) => row.membership === "absent").length,
  unknown: rows.filter((row) => row.membership === "unknown").length,
  authoritativeLinked: rows.filter((row) => row.verified).length,
  discordAuthorityConflicts: rows.filter((row) => !row.verified).length,
  missingDiscordIdentities: rows.filter((row) =>
    ["missing_principal", "missing_authoritative_identity"].includes(row.conflictCode)
  ).length,
  mismatchedDiscordIdentities: rows.filter((row) =>
    ["principal_mismatch", "legacy_identity_mismatch"].includes(row.conflictCode)
  ).length,
  duplicateDiscordMappings: rows.filter((row) =>
    row.conflictCode === "duplicate_principal_mapping"
  ).length,
  inactiveTourneyAccounts: rows.filter((row) =>
    row.conflictCode === "inactive_tourney_account"
  ).length,
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
  activeQueueBlockers:
    Number(databaseState?.mirror_blockers || 0) +
    Number(databaseState?.external_blockers || 0) +
    Number(databaseState?.email_blockers || 0) +
    Number(databaseState?.auth_blockers || 0),
  latencyBaselines: Number(databaseState?.latency_baselines || 0),
  databaseControlsReady: [databaseState, databaseState?.legacyControl].every(
    (control) => control?.primary_backend === "supabase" &&
      Number(control?.generation) === 1 && control?.writes_paused === true &&
      control?.hardened_active === true
  ),
});

export const activateTourneySchemaV4 = async ({ env = process.env } = {}) => {
  requireActivationPolicy(env);
  await assertTourneyMirrorCatalogParityV4({ env });
  const [sql, legacySql] = await Promise.all([
    getTourneySql(env),
    getTourneySqlForBackend({ backend: "legacy", env }),
  ]);
  const [legacyControl] = await legacySql`
    select metadata.primary_backend, metadata.generation, metadata.writes_paused,
      metadata.fallback_read_only, metadata.hardened_active,
      schema_state.schema_version
    from tourney_cutover_metadata metadata
    join tourney_schema_metadata schema_state on schema_state.schema_name = 'tourney'
    where metadata.id = 'tourney'
  `;
  if (
    legacyControl?.primary_backend !== "supabase" ||
    Number(legacyControl?.generation) !== 1 ||
    legacyControl?.writes_paused !== true ||
    legacyControl?.fallback_read_only === true ||
    legacyControl?.hardened_active !== true ||
    Number(legacyControl?.schema_version || 0) < 4
  ) {
    const error = new Error("Legacy Tourney schema-v4 activation is not ready.");
    error.code = "TOURNEY_LEGACY_ACTIVATION_REQUIRED";
    error.status = 409;
    throw error;
  }
  const [row] = await sql`
    select public.roo_activate_tourney_schema_v4('schema-v4-activation') result
  `;
  return row?.result || { activated: false };
};

export const captureTourneyLatencyBaselineV4 = async ({
  actor = "schema-v4-preactivation",
  env = process.env,
} = {}) => {
  requireActivationPolicy(env);
  const sql = await getTourneySql(env);
  const [row] = await sql`
    select public.roo_capture_tourney_shadow_latency_baseline(${actor}) result
  `;
  return row?.result || { captured: 0 };
};

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
      playerId: player.playerId,
      discordUserId: player.discordUserId,
      verified: player.verified,
      conflictCode: player.conflictCode,
      desiredRole: "participant",
      ...(player.verified
        ? await readDiscordMember({
            config,
            discordUserId: player.discordUserId,
            fetchImpl,
            sleepImpl,
          })
        : { membership: "not_checked", managedRoles: [] }),
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
  const accounts = await readActivationSourceAccounts(env);
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
    attemptExternalWork: false,
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
      attemptExternalWork: false,
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

export const backfillTourneyEmailHistoryV4 = async ({ env = process.env } = {}) => {
  const commandId = "email-history-backfill:g1:v4";
  const result = await executeTourneyCommand({
    commandId,
    purpose: "email:history-backfill",
    requestPayload: { generation: 1, schemaVersion: 4, send: false },
    attemptExternalWork: false,
    maintenanceWhilePaused: true,
    env,
    callback: async () => {
      const sql = await getTourneySql(env);
      const [row] = await sql`
        select public.roo_backfill_tourney_email_history_v4(
          'schema-v4-activation'
        ) result
      `;
      return { body: row?.result || { inserted: 0 } };
    },
  });
  return {
    inserted: Number(result.body?.inserted || 0),
    commandId,
    syncPending: Boolean(result.syncPending),
  };
};

export const seedTourneyDiscordDesiredStateV4 = async ({ env = process.env } = {}) => {
  const config = getTourneyDiscordRoleConfig(env);
  if (!config.enabled) throw new Error("Tourney Discord reconciliation is not configured.");
  const policy = resolveTourneyStorePolicy(env);
  const authoritySql = await getTourneySql(env);
  const players = await readAuthoritativeDiscordPlayers({ sql: authoritySql });
  assertAuthoritativeDiscordPlayers(players);
  const normalizationCommandId = `discord-state-normalize:g${policy.generation}:v4`;
  const normalization = await executeTourneyCommand({
    commandId: normalizationCommandId,
    purpose: "discord:backfill",
    requestPayload: { generation: policy.generation, schemaVersion: 4 },
    attemptExternalWork: false,
    maintenanceWhilePaused: true,
    env,
    callback: async () => {
      const sql = await getTourneySql(env);
      const rows = await sql`
        update accounts.discord_role_assignments assignment set
          player_id = case
            when account.role = 'tourney_player' then account.legacy_sanity_id
            else assignment.player_id
          end,
          status = case
            when assignment.status = 'blocked' then 'blocked_reauth'
            else assignment.status
          end,
          blocked_at = case
            when assignment.status = 'blocked' then
              coalesce(assignment.blocked_at, assignment.updated_at, now())
            else assignment.blocked_at
          end,
          updated_at = now()
        from accounts.tourney_accounts account
        where account.principal_id = assignment.principal_id
          and (
            (
              account.role = 'tourney_player'
              and account.legacy_sanity_id is not null
              and assignment.player_id is distinct from account.legacy_sanity_id
            )
            or assignment.status = 'blocked'
          )
        returning assignment.principal_id
      `;
      return { body: { normalized: rows.length } };
    },
  });
  for (const player of players) {
    const commandId = [
      "discord-state-seed",
      `g${policy.generation}`,
      "v3",
      player.playerId,
      player.discordUserId,
    ].join(":");
    await executeTourneyCommand({
      commandId,
      purpose: "discord:backfill",
      requestPayload: {
        playerId: player.playerId,
        discordUserId: player.discordUserId,
        identityAuthority: "accounts.identity_links",
      },
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
            and entity_id=${player.playerId} and command_id<>${commandId}
            and status in ('pending','retry')
        `;
        const assignment = await recordTourneyDiscordDesiredState({
          player: { id: player.playerId },
          discordUser: { id: player.discordUserId },
          guildId: config.guildId,
          env,
        });
        await enqueueTourneyExternalOperation({
          commandId,
          operationKind: "discord_role_reconcile",
          entityType: "player",
          entityId: player.playerId,
          desiredState: { assignment: {
            principalId: assignment.principal_id,
            discordUserId: assignment.discord_user_id,
            previousDiscordUserId: assignment.previous_discord_user_id || "",
            staleDiscordUserIds: assignment.stale_discord_user_ids || [],
            desiredRole: assignment.desired_role,
            generation: Number(assignment.generation),
          } },
          env,
        });
        return { body: { ok: true } };
      },
    });
  }
  return {
    queued: players.length,
    normalized: Number(normalization.body?.normalized || 0),
    contactedDiscord: false,
  };
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
      inventory.counts.discordAuthorityConflicts > 0 ||
      inventory.counts.missingDiscordIdentities > 0 ||
      inventory.counts.mismatchedDiscordIdentities > 0 ||
      inventory.counts.duplicateDiscordMappings > 0 ||
      inventory.counts.ambiguousImports > 0 || inventory.counts.activeQueueBlockers > 0 ||
      inventory.counts.latencyBaselines !== 5 ||
      !inventory.counts.databaseControlsReady) {
    const error = new Error("Tourney activation inventory changed or is blocked.");
    error.code = "TOURNEY_ACTIVATION_INVENTORY_BLOCKED";
    error.status = 409;
    throw error;
  }
  const { withTourneyReconciliationLease } = await import("./reconcile.js");
  const leased = await withTourneyReconciliationLease({
    env,
    leaseMs: 10 * 60 * 1000,
    callback: async () => {
      const refreshed = await inventoryTourneyV4Activation({ env, fetchImpl });
      if (
        refreshed.inventoryHash !== expectedHash ||
        refreshed.counts.activeQueueBlockers > 0 ||
        refreshed.counts.discordAuthorityConflicts > 0 ||
        refreshed.counts.missingDiscordIdentities > 0 ||
        refreshed.counts.mismatchedDiscordIdentities > 0 ||
        refreshed.counts.duplicateDiscordMappings > 0
      ) {
        const error = new Error("Tourney activation inventory changed while acquiring its lease.");
        error.code = "TOURNEY_ACTIVATION_INVENTORY_CHANGED";
        error.status = 409;
        throw error;
      }
      return {
        accountSnapshot: await seedTourneyAccountSnapshotV4({ env }),
        principals: await seedTourneyPlayerPrincipalsV4({ env }),
        emailHistory: await backfillTourneyEmailHistoryV4({ env }),
        discord: await seedTourneyDiscordDesiredStateV4({ env }),
      };
    },
  });
  if (!leased.acquired) {
    const error = new Error("Tourney reconciliation is still active.");
    error.code = "TOURNEY_ACTIVATION_RECONCILIATION_ACTIVE";
    error.status = 409;
    throw error;
  }
  const { accountSnapshot, principals, emailHistory, discord } = leased.value;
  return {
    applied: true,
    inventoryHash: expectedHash,
    accountSnapshot,
    principals,
    emailHistory,
    discord,
  };
};
