#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import migrationTargetSafety from "../src/server/supabase/migrationTargetSafety.cjs";
import { buildPostgresConnectionOptions } from "./lib/postgres-connection-env.mjs";
import {
  expectedConnectedDatabaseUsername,
  loadSupabaseDatabaseTargetFromStdin,
} from "./lib/supabase-database-target-stdin.mjs";
import {
  decryptSnapshot,
  readSnapshotSecret,
  stableJson,
  validateHostedSnapshot,
} from "./tourney-cutover.mjs";
import { validateFullLogicalSnapshot } from "../src/server/tourney/snapshotContract.js";

const {
  assertTourneyCutoverLegacyTarget,
  assertTourneyCutoverSupabaseDatabaseTarget,
} = migrationTargetSafety;

export const EXPECTED_LIVE_DRIFT = Object.freeze({
  tokens: Object.freeze({
    sourceCount: 633,
    targetCount: 633,
    differentRows: 3,
    missingSource: 0,
    missingTarget: 0,
    recipientVersionOnly: 3,
    otherFieldDrift: 0,
    sourceRecipientVersion: "3",
    targetRecipientVersion: null,
    diffSetHash: "c75829f0006667a810595cc02628e26f02c10ebdfa4abc936cce351f2784c29b",
  }),
  discord: Object.freeze({
    sourceCount: 25,
    targetCount: 24,
    exactPrincipalRows: 0,
    differentPrincipalRows: 24,
    sourceOnly: 1,
    targetOnly: 0,
    diffSetHash: "9bbd5b095591c66d96d25b574407490a670c1eb8cd0b24b65ec6068241d27b49",
  }),
  collision: Object.freeze({
    count: 1,
    sourceHash: "4fcaa4fd216a92bbc07d5bb1ff66d347554aad44d74d33e04e70972cb53be56b",
    playerHash: "9dff440484cf80e8d492437d90d02794f92c9d261dc1f656861bcd1f6ea766c1",
    discordHash: "f7fcaa07d097e841c7c15e3efeea702ec189e69f7efc0a7e005919259753517b",
    linkedPrincipalHash: "905d056a89020d182720b56dc08cc74b87c15011c88cc26da4397cbeedee235c",
    canonicalPrincipalHash: "941942717235b4b5f0422aa5378aaeff3c5ae7ebf46e85a67e76d0a6498edd21",
  }),
  events: Object.freeze({
    tourney_player_tokens: 3,
    discord_role_assignments: 25,
    tourney_players: 1,
    total: 29,
  }),
});

const REPAIR_VERSION = "tourney-live-drift-repair-v1";
const BLOCKED_ERROR_CODE = "identity_principal_collision";
const LEGACY_TRIGGER_BODY_HASH = "36214a1fe065a142c2d83684c9f8e7d6";
const LIVE_DRIFT_CONNECTION_LIMIT = 7;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const normalizeRows = (rows = []) => JSON.parse(JSON.stringify(rows)).sort((left, right) =>
  stableJson(left).localeCompare(stableJson(right))
);
const readFullLogicalSnapshotRows = (snapshot, relation) => {
  const rowsText = snapshot?.supabase?.payload?.full_logical?.relationPayloads?.[relation];
  let rows;
  try {
    rows = JSON.parse(rowsText);
  } catch {
    rows = null;
  }
  requireCondition(Array.isArray(rows),
    "Verified snapshot relation is invalid.", "LIVE_DRIFT_SNAPSHOT_INVALID");
  return rows;
};
const repairError = (message, code) => Object.assign(new Error(message), { code });
const requireCondition = (condition, message, code) => {
  if (!condition) throw repairError(message, code);
};
const flagEnabled = (value) => ["1", "true", "yes", "on"].includes(
  String(value || "").trim().toLowerCase()
);

export const buildLiveDriftAuthorizationHash = (expected = EXPECTED_LIVE_DRIFT) =>
  sha256(stableJson({ expected, repairVersion: REPAIR_VERSION }));

export const buildLiveDriftConflictId = (collisionHash) => {
  requireCondition(SHA256_PATTERN.test(collisionHash), "Collision hash is invalid.", "LIVE_DRIFT_HASH_INVALID");
  const chars = collisionHash.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ["8", "9", "a", "b"][Number.parseInt(chars[16], 16) % 4];
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const parseLiveDriftArguments = (argv = process.argv.slice(2)) => {
  const actionFlags = new Set(["--preflight", "--apply", "--finalize"]);
  const valueFlags = new Set(["--env", "--authorization-hash", "--verified-snapshot"]);
  const booleanFlags = new Set(["--supabase-database-url-stdin"]);
  const allowed = new Set([...actionFlags, ...valueFlags, ...booleanFlags]);
  const seen = new Set();
  const actions = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    requireCondition(allowed.has(token), "Repair command argument is invalid.", "LIVE_DRIFT_ARGUMENT_INVALID");
    requireCondition(!seen.has(token), "Repair command argument is duplicated.", "LIVE_DRIFT_ARGUMENT_DUPLICATE");
    seen.add(token);
    if (actionFlags.has(token)) {
      actions.push(token);
      continue;
    }
    if (booleanFlags.has(token)) continue;
    const value = String(argv[index + 1] || "").trim();
    requireCondition(value && !value.startsWith("--"),
      `A value is required after ${token}.`, "LIVE_DRIFT_ARGUMENT_INVALID");
    index += 1;
  }
  requireCondition(actions.length === 1, "Select exactly one repair action.", "LIVE_DRIFT_ACTION_INVALID");
  requireCondition(
    seen.has("--supabase-database-url-stdin"),
    "The Supabase database target must be supplied through stdin.",
    "LIVE_DRIFT_DATABASE_STDIN_REQUIRED"
  );
  const readValue = (flag, required = false) => {
    const index = argv.indexOf(flag);
    const value = index >= 0 ? String(argv[index + 1] || "").trim() : "";
    if (required && (!value || value.startsWith("--"))) {
      throw repairError(`A value is required after ${flag}.`, "LIVE_DRIFT_ARGUMENT_INVALID");
    }
    return value;
  };
  const action = actions[0].slice(2);
  return {
    action,
    envPath: readValue("--env", true),
    authorizationHash: readValue("--authorization-hash", action !== "preflight"),
    snapshotPath: readValue("--verified-snapshot", action === "apply"),
    useSupabaseDatabaseUrlStdin: seen.has("--supabase-database-url-stdin"),
  };
};

const loadPrivateEnvironment = (envPath) => {
  const resolved = path.resolve(envPath);
  const stats = fs.statSync(resolved);
  requireCondition(stats.isFile() && (stats.mode & 0o077) === 0,
    "Repair environment file must be private.", "LIVE_DRIFT_ENV_INVALID");
  const isolatedPrefixes = ["SUPABASE_", "TOURNEY_", "NEXT_PUBLIC_SUPABASE_", "POSTGRES_"];
  for (const key of Object.keys(process.env)) {
    if (isolatedPrefixes.some((prefix) => key.startsWith(prefix)) || key === "DATABASE_URL") {
      delete process.env[key];
    }
  }
  const loaded = dotenv.config({ path: resolved, override: true, quiet: true });
  if (loaded.error) throw loaded.error;
  return resolved;
};

const assertRuntimeEnvironment = (env = process.env) => {
  requireCondition(String(env.TOURNEY_DATABASE_MODE || "").toLowerCase() === "supabase",
    "Supabase must remain the Tourney primary.", "LIVE_DRIFT_PRIMARY_INVALID");
  requireCondition(flagEnabled(env.TOURNEY_WRITES_PAUSED),
    "Tourney writes must be paused.", "LIVE_DRIFT_WRITES_NOT_PAUSED");
  requireCondition(flagEnabled(env.TOURNEY_HARDENING_V4_ENABLED),
    "Tourney hardening must be active.", "LIVE_DRIFT_HARDENING_INACTIVE");
  requireCondition(flagEnabled(env.TOURNEY_MIRROR_ENABLED),
    "Tourney mirroring must be enabled.", "LIVE_DRIFT_MIRROR_DISABLED");
  requireCondition(String(env.TOURNEY_FAILOVER_GENERATION || "") === "1",
    "Tourney generation must be one.", "LIVE_DRIFT_GENERATION_INVALID");
  requireCondition(Boolean(env.SUPABASE_DATABASE_URL && env.TOURNEY_DATABASE_URL),
    "Both Tourney databases must be configured.", "LIVE_DRIFT_DATABASE_UNAVAILABLE");
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const sourceIdentity = assertTourneyCutoverSupabaseDatabaseTarget({
    databaseUrl: env.SUPABASE_DATABASE_URL,
    supabaseUrl,
    expectedFingerprint: env.TOURNEY_CUTOVER_EXPECTED_SUPABASE_DATABASE_FINGERPRINT,
  });
  const legacyIdentity = assertTourneyCutoverLegacyTarget({
    databaseUrl: env.TOURNEY_DATABASE_URL,
    expectedFingerprint: env.TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT,
  });
  return { sourceIdentity, legacyIdentity };
};

const connect = (databaseUrl, applicationName) => postgres({
  ...buildPostgresConnectionOptions(databaseUrl),
  max: LIVE_DRIFT_CONNECTION_LIMIT,
  idle_timeout: 10,
  connect_timeout: 10,
  prepare: false,
  connection: {
    application_name: applicationName,
    search_path: "pg_catalog,public",
  },
});

export const assertConnectedDatabaseIdentity = async (sql, identity, code) => {
  const [connected] = await sql`
    select pg_catalog.current_database() database, current_user username
  `;
  requireCondition(connected?.database === identity?.database &&
    connected?.username === expectedConnectedDatabaseUsername(identity),
  "Connected PostgreSQL identity does not match the pinned target.", code);
  return connected;
};

export const assertLiveDriftSummary = (summary, expected = EXPECTED_LIVE_DRIFT) => {
  const token = summary.tokens;
  const discord = summary.discord;
  const collision = summary.collision;
  const tokenChecks = [
    [token.source_count, expected.tokens.sourceCount],
    [token.target_count, expected.tokens.targetCount],
    [token.different_rows, expected.tokens.differentRows],
    [token.missing_source, expected.tokens.missingSource],
    [token.missing_target, expected.tokens.missingTarget],
    [token.recipient_version_only, expected.tokens.recipientVersionOnly],
    [token.other_field_drift, expected.tokens.otherFieldDrift],
    [token.diff_set_hash, expected.tokens.diffSetHash],
  ];
  requireCondition(tokenChecks.every(([actual, wanted]) => actual === wanted),
    "Token drift does not match the reviewed repair set.", "LIVE_DRIFT_TOKEN_MISMATCH");
  requireCondition(token.diffs.length === expected.tokens.differentRows && token.diffs.every((row) =>
    row.source_recipient_version === expected.tokens.sourceRecipientVersion &&
    row.target_recipient_version === expected.tokens.targetRecipientVersion &&
    row.other_fields_equal === true
  ), "Token drift fields changed after review.", "LIVE_DRIFT_TOKEN_FIELDS_MISMATCH");
  const discordChecks = [
    [discord.source_count, expected.discord.sourceCount],
    [discord.target_count, expected.discord.targetCount],
    [discord.exact_principal_rows, expected.discord.exactPrincipalRows],
    [discord.different_principal_rows, expected.discord.differentPrincipalRows],
    [discord.source_only, expected.discord.sourceOnly],
    [discord.target_only, expected.discord.targetOnly],
    [discord.diff_set_hash, expected.discord.diffSetHash],
  ];
  requireCondition(discordChecks.every(([actual, wanted]) => actual === wanted),
    "Discord drift does not match the reviewed repair set.", "LIVE_DRIFT_DISCORD_MISMATCH");
  requireCondition(collision.count === expected.collision.count &&
    collision.source_hash === expected.collision.sourceHash &&
    collision.player_hash === expected.collision.playerHash &&
    collision.discord_hash === expected.collision.discordHash &&
    collision.linked_principal_hash === expected.collision.linkedPrincipalHash &&
    collision.canonical_principal_hash === expected.collision.canonicalPrincipalHash,
  "Discord identity authority changed after review.", "LIVE_DRIFT_COLLISION_MISMATCH");
  requireCondition(collision.authority?.canonical === true,
    "The canonical Discord principal is not proven.", "LIVE_DRIFT_AUTHORITY_UNPROVEN");
  return summary;
};

const readLegacyRows = async (legacy) => {
  const [tokens, assignments, players] = await Promise.all([
    legacy`select to_jsonb(row_value) row from tourney_player_tokens row_value order by id`,
    legacy`select to_jsonb(row_value) row from tourney_discord_role_assignments row_value order by principal_id`,
    legacy`select to_jsonb(row_value) row from tourney_players row_value order by id`,
  ]);
  return {
    tokens: tokens.map(({ row }) => row),
    assignments: assignments.map(({ row }) => row),
    players: players.map(({ row }) => row),
  };
};

export const assertLiveDriftDatabaseGate = async (sql, { allowConflictId = "" } = {}) => {
  const [gate] = await sql`
    select metadata.primary_backend, metadata.generation, metadata.writes_paused,
      metadata.hardened_active, schema.schema_version,
      (select count(*)::integer from tourney.mirror_outbox
        where status in ('pending','processing','retry')) mirror_active,
      (select count(*)::integer from tourney.mirror_outbox
        where status='dead_letter') mirror_dead,
      (select count(*)::integer from tourney.external_operations
        where status in ('pending','processing','retry','dead_letter')) external_blocked,
      (select count(*)::integer from tourney.email_dispatches
        where status in ('pending','sending','retry')) email_active,
      (select count(*)::integer from tourney.command_receipts
        where status='processing') receipt_processing,
      (select count(*)::integer from tourney.identity_conflicts
        where resolved_at is null and (${allowConflictId || null}::uuid is null or id<>${allowConflictId || null}::uuid)
      ) unrelated_identity_conflicts,
      (select count(*)::integer from migration.tourney_import_quarantine
        where resolved_at is null) import_quarantine
    from tourney.cutover_metadata metadata
    join tourney.schema_metadata schema on schema.schema_name='tourney'
    where metadata.id='tourney'
  `;
  requireCondition(gate?.primary_backend === "supabase" && Number(gate.generation) === 1 &&
    gate.writes_paused === true && gate.hardened_active === true && Number(gate.schema_version) >= 4,
  "Database cutover controls are not repair-safe.", "LIVE_DRIFT_DATABASE_GATE_INVALID");
  requireCondition([
    gate.mirror_active, gate.mirror_dead, gate.external_blocked, gate.email_active,
    gate.receipt_processing, gate.unrelated_identity_conflicts, gate.import_quarantine,
  ].every((value) => Number(value) === 0),
  "A database backlog or unrelated blocker prevents repair.", "LIVE_DRIFT_DATABASE_BACKLOG");
  const bindings = await sql`
    select contract.logical_table,
      count(trigger.oid)::integer trigger_count,
      count(trigger.oid) filter (
        where trigger.tgenabled in ('O','A')
          and trigger.tgfoid='tourney.capture_mirror_event_v4()'::regprocedure
      )::integer valid_count
    from tourney.mirror_contracts contract
    left join pg_trigger trigger
      on trigger.tgrelid=contract.supabase_relation::regclass
     and trigger.tgname='capture_tourney_mirror_event'
     and not trigger.tgisinternal
    where contract.enabled
    group by contract.logical_table
    order by contract.logical_table
  `;
  requireCondition(bindings.length > 0 && bindings.every((row) =>
    Number(row.trigger_count) === 1 && Number(row.valid_count) === 1
  ), "A mirror trigger is not bound to the v4 capture function.", "LIVE_DRIFT_TRIGGER_BINDING_INVALID");
  const contracts = await sql`
    select logical_table,key_columns from tourney.mirror_contracts
    where logical_table in ('tourney_player_tokens','discord_role_assignments','tourney_players')
    order by logical_table
  `;
  const keys = Object.fromEntries(contracts.map((row) => [row.logical_table, row.key_columns]));
  requireCondition(stableJson(keys.tourney_player_tokens) === stableJson(["id"]) &&
    stableJson(keys.discord_role_assignments) === stableJson(["principal_id"]) &&
    stableJson(keys.tourney_players) === stableJson(["id"]),
  "Mirror contract keys changed after review.", "LIVE_DRIFT_CONTRACT_INVALID");
  return { contractCount: bindings.length };
};

export const assertLiveDriftLegacyDatabaseGate = async (
  sql,
  { allowConflictId = "" } = {}
) => {
  const [gate] = await sql`
    select metadata.primary_backend,metadata.generation,metadata.writes_paused,
      metadata.fallback_read_only,metadata.hardened_active,schema.schema_version,
      (select count(*)::integer from public.tourney_mirror_outbox
        where status in ('pending','processing','retry','dead_letter')) mirror_blocked,
      (select count(*)::integer from public.tourney_external_operations
        where status in ('pending','processing','retry','dead_letter')) external_blocked,
      (select count(*)::integer from public.tourney_email_dispatches
        where status in ('pending','sending','retry','failed')) email_blocked,
      (select count(*)::integer from public.tourney_command_receipts
        where status='processing') receipt_processing,
      (select count(*)::integer from public.tourney_import_quarantine
        where resolved_at is null) import_quarantine,
      (select count(*)::integer from public.tourney_identity_conflicts
        where resolved_at is null
          and (${allowConflictId || null}::uuid is null or id<>${allowConflictId || null}::uuid)
      ) unrelated_identity_conflicts
    from public.tourney_cutover_metadata metadata
    join public.tourney_schema_metadata schema on schema.schema_name='tourney'
    where metadata.id='tourney'
  `;
  requireCondition(gate?.primary_backend === "supabase" && Number(gate.generation) === 1 &&
    gate.writes_paused === true && gate.fallback_read_only === false &&
    gate.hardened_active === true && Number(gate.schema_version) === 4,
  "Fallback cutover controls are not repair-safe.", "LIVE_DRIFT_LEGACY_GATE_INVALID");
  requireCondition([
    gate.mirror_blocked,gate.external_blocked,gate.email_blocked,
    gate.receipt_processing,gate.import_quarantine,gate.unrelated_identity_conflicts,
  ].every((value) => Number(value) === 0),
  "A fallback backlog or unrelated blocker prevents repair.", "LIVE_DRIFT_LEGACY_BACKLOG");
  const [bindingRow] = await sql`
    select public.tourney_mirror_trigger_binding_status_v4() status
  `;
  const binding = bindingRow?.status;
  requireCondition(binding?.ready === true && binding.contract_version === "v4-fail-closed-20260715" &&
    Number(binding.enabled_contracts) === 17 && Number(binding.correctly_bound) === 17 &&
    binding.function_body_matches === true &&
    binding.function_body_hash === LEGACY_TRIGGER_BODY_HASH &&
    Array.isArray(binding.drifted_tables) && binding.drifted_tables.length === 0,
  "Fallback mirror triggers are not ready.", "LIVE_DRIFT_LEGACY_TRIGGER_INVALID");
  return { contractCount: Number(binding.enabled_contracts), functionBodyHash: binding.function_body_hash };
};

const inspectTokenDrift = async (source, targetRows) => {
  const [result] = await source`
    with target_items as (
      select value->>'id' id,value row
      from jsonb_array_elements(${source.json(targetRows)}::jsonb)
    ), source_items as (
      select id,to_jsonb(row_value) row from tourney.tourney_player_tokens row_value
    ), compared as (
      select coalesce(source.id,target.id) id,source.row source_row,target.row target_row
      from source_items source full join target_items target using(id)
    ), diffs as (
      select *, (source_row-'recipient_version') is not distinct from
        (target_row-'recipient_version') other_fields_equal
      from compared where source_row is distinct from target_row
    )
    select
      (select count(*)::integer from source_items) source_count,
      (select count(*)::integer from target_items) target_count,
      count(*)::integer different_rows,
      count(*) filter(where source_row is null)::integer missing_source,
      count(*) filter(where target_row is null)::integer missing_target,
      count(*) filter(where other_fields_equal)::integer recipient_version_only,
      count(*) filter(where not other_fields_equal)::integer other_field_drift,
      encode(extensions.digest(coalesce(jsonb_agg(jsonb_build_object(
        'id_hash',encode(extensions.digest(id,'sha256'),'hex'),
        'source_recipient_version',source_row->>'recipient_version',
        'target_recipient_version',target_row->>'recipient_version'
      ) order by id)::text,'[]'),'sha256'),'hex') diff_set_hash,
      coalesce(jsonb_agg(jsonb_build_object(
        'id',id,
        'id_hash',encode(extensions.digest(id,'sha256'),'hex'),
        'source_recipient_version',source_row->>'recipient_version',
        'target_recipient_version',target_row->>'recipient_version',
        'other_fields_equal',other_fields_equal
      ) order by id),'[]'::jsonb) diffs
    from diffs
  `;
  return result;
};

const inspectDiscordDrift = async (source, targetRows) => {
  const [result] = await source`
    with target_items as (
      select value->>'principal_id' principal_id,value row
      from jsonb_array_elements(${source.json(targetRows)}::jsonb)
    ), source_items as (
      select principal_id::text principal_id,to_jsonb(row_value) row
      from accounts.discord_role_assignments row_value
    ), compared as (
      select coalesce(source.principal_id,target.principal_id) principal_id,
        source.row source_row,target.row target_row
      from source_items source full join target_items target using(principal_id)
    )
    select
      (select count(*)::integer from source_items) source_count,
      (select count(*)::integer from target_items) target_count,
      count(*) filter(where source_row is not null and source_row is not distinct from target_row)::integer exact_principal_rows,
      count(*) filter(where source_row is not null and target_row is not null and source_row is distinct from target_row)::integer different_principal_rows,
      count(*) filter(where source_row is not null and target_row is null)::integer source_only,
      count(*) filter(where source_row is null and target_row is not null)::integer target_only,
      encode(extensions.digest(coalesce(jsonb_agg(jsonb_build_object(
        'principal_hash',encode(extensions.digest(principal_id,'sha256'),'hex'),
        'source',source_row,'target',target_row
      ) order by principal_id) filter(where source_row is distinct from target_row)::text,'[]'),'sha256'),'hex') diff_set_hash,
      coalesce(jsonb_agg(principal_id order by principal_id)
        filter(where source_row is not null),'[]'::jsonb) source_principal_ids
    from compared
  `;
  return result;
};

const inspectCollision = async (source) => {
  const [result] = await source`
    with collision as (
      select player.id player_id,player.email player_email,
        player.principal_id linked_principal_id,player.discord_user_id,
        linked_account.user_id linked_user_id,
        claimed.id identity_link_id,claimed.user_id claimed_user_id,
        claimed.principal_id canonical_principal_id,
        claimed.provider_email identity_email,
        claimed.backend_owner identity_backend_owner,
        auth_identity.id auth_identity_id,auth_identity.user_id auth_identity_user_id,
        auth_identity.email auth_identity_email,
        claimed_user.email claimed_user_email,
        linked_user.email linked_user_email,
        claimed_account.user_id claimed_account_user_id
      from tourney.tourney_players player
      join accounts.identity_links claimed
        on claimed.provider='discord'
       and claimed.provider_subject=player.discord_user_id
       and claimed.principal_id<>player.principal_id
      join accounts.tourney_accounts linked_account
        on linked_account.principal_id=player.principal_id
       and linked_account.legacy_sanity_id=player.id
       and linked_account.role='tourney_player'
       and linked_account.active=true
       and linked_account.lifecycle_status='approved'
      join accounts.principal_auth_users linked_mapping
        on linked_mapping.principal_id=player.principal_id
       and linked_mapping.user_id=linked_account.user_id
      join auth.users linked_user on linked_user.id=linked_account.user_id
      join auth.users claimed_user on claimed_user.id=claimed.user_id
      join auth.identities auth_identity
        on auth_identity.provider='discord'
       and auth_identity.provider_id=player.discord_user_id
       and auth_identity.user_id=claimed.user_id
      join accounts.principal_auth_users claimed_mapping
        on claimed_mapping.principal_id=claimed.principal_id
       and claimed_mapping.user_id=claimed.user_id
      left join accounts.tourney_accounts claimed_account
        on claimed_account.principal_id=claimed.principal_id
      where player.status='approved'
    ), canonical as (
      select *,jsonb_build_object(
        'collision_kind','cross_principal_discord_identity',
        'player_id',player_id,
        'linked_principal_id',linked_principal_id,
        'claimed_principal_id',canonical_principal_id,
        'discord_user_id',discord_user_id
      ) snapshot
      from collision
    )
    select count(*)::integer count,
      encode(extensions.digest(coalesce(jsonb_agg(snapshot order by player_id)::text,'[]'),'sha256'),'hex') source_hash,
      min(player_id) player_id,min(linked_principal_id::text) linked_principal_id,
      min(canonical_principal_id::text) canonical_principal_id,
      min(discord_user_id) discord_user_id,min(identity_link_id::text) identity_link_id,
      encode(extensions.digest(min(player_id),'sha256'),'hex') player_hash,
      encode(extensions.digest(min(discord_user_id),'sha256'),'hex') discord_hash,
      encode(extensions.digest(min(linked_principal_id::text),'sha256'),'hex') linked_principal_hash,
      encode(extensions.digest(min(canonical_principal_id::text),'sha256'),'hex') canonical_principal_hash,
      jsonb_build_object(
        'canonical',bool_and(
          identity_backend_owner='supabase' and auth_identity_id is not null
          and auth_identity_user_id=claimed_user_id
          and lower(btrim(claimed_user_email))=lower(btrim(identity_email))
          and lower(btrim(auth_identity_email))=lower(btrim(identity_email))
          and lower(btrim(player_email))<>lower(btrim(identity_email))
          and lower(btrim(linked_user_email))<>lower(btrim(identity_email))
          and linked_user_id<>claimed_user_id and claimed_account_user_id is null
        )
      ) authority
    from canonical
  `;
  return result;
};

export const inspectLiveDrift = async ({
  source,
  legacy,
  expected = EXPECTED_LIVE_DRIFT,
  allowConflictId = "",
}) => {
  await assertLiveDriftDatabaseGate(source);
  await assertLiveDriftLegacyDatabaseGate(legacy, { allowConflictId });
  const legacyRows = await readLegacyRows(legacy);
  const [tokens, discord, collision, sourceTokens, sourceAssignments, sourcePlayers, identities] =
    await Promise.all([
      inspectTokenDrift(source, legacyRows.tokens),
      inspectDiscordDrift(source, legacyRows.assignments),
      inspectCollision(source),
      source`select to_jsonb(row_value) row from tourney.tourney_player_tokens row_value order by id`,
      source`select to_jsonb(row_value) row from accounts.discord_role_assignments row_value order by principal_id`,
      source`select to_jsonb(row_value) row from tourney.tourney_players row_value order by id`,
      source`select to_jsonb(row_value) row from accounts.identity_links row_value order by id`,
    ]);
  const summary = { tokens, discord, collision };
  assertLiveDriftSummary(summary, expected);
  return {
    ...summary,
    legacyRows,
    sourceRows: {
      tokens: sourceTokens.map(({ row }) => row),
      assignments: sourceAssignments.map(({ row }) => row),
      players: sourcePlayers.map(({ row }) => row),
      identities: identities.map(({ row }) => row),
    },
  };
};

export const resolveApprovedSnapshotPath = (
  snapshotPath,
  { homeDirectory = os.homedir() } = {}
) => {
  requireCondition(path.isAbsolute(snapshotPath),
    "Verified snapshot path must be absolute.", "LIVE_DRIFT_SNAPSHOT_INVALID");
  const approvedRoot = path.join(homeDirectory, "Documents", "Codex", "Tourney Cutover");
  let rootRealPath;
  let snapshotRealPath;
  let snapshotStats;
  try {
    rootRealPath = fs.realpathSync(approvedRoot);
    snapshotStats = fs.lstatSync(snapshotPath);
    snapshotRealPath = fs.realpathSync(snapshotPath);
  } catch {
    throw repairError("Verified snapshot path is invalid.", "LIVE_DRIFT_SNAPSHOT_INVALID");
  }
  const relative = path.relative(rootRealPath, snapshotRealPath);
  const insideRoot = relative && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  requireCondition(snapshotStats.isFile() && !snapshotStats.isSymbolicLink() && insideRoot,
    "Verified snapshot must be a regular file in the approved cutover folder.",
    "LIVE_DRIFT_SNAPSHOT_LOCATION_INVALID");
  return snapshotRealPath;
};

const verifySnapshotProof = async ({ snapshotPath, state, env = process.env }) => {
  const resolved = resolveApprovedSnapshotPath(snapshotPath);
  const encrypted = fs.readFileSync(resolved);
  let secret;
  try {
    secret = await readSnapshotSecret(encrypted, env);
  } catch {
    throw repairError("Snapshot key is unavailable.", "LIVE_DRIFT_SNAPSHOT_KEY_INVALID");
  }
  const snapshot = decryptSnapshot({ encrypted, secret });
  validateHostedSnapshot({
    data: {
      snapshot_id: snapshot?.supabase?.snapshotId,
      payload_sha256: snapshot?.supabase?.payloadSha256,
      table_counts: snapshot?.supabase?.tableCounts,
      payload: snapshot?.supabase?.payload,
      payload_text: snapshot?.supabase?.payloadText,
      hosted_roundtrip_verified: snapshot?.supabase?.hostedRoundtripVerified,
    },
    legacyData: snapshot?.legacy,
    sanityAccount: snapshot?.sanityAccount,
  });
  try {
    validateFullLogicalSnapshot(snapshot?.supabase?.payload, { hash: sha256 });
  } catch {
    throw repairError(
      "Verified snapshot full logical proof is invalid.",
      "LIVE_DRIFT_SNAPSHOT_INVALID"
    );
  }
  const ageMs = Date.now() - Date.parse(snapshot.capturedAt || "");
  requireCondition(Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 30 * 60 * 1000,
    "Verified snapshot is not fresh.", "LIVE_DRIFT_SNAPSHOT_STALE");
  const comparisons = [
    [snapshot.legacy?.tourney_player_tokens, state.legacyRows.tokens],
    [snapshot.legacy?.tourney_discord_role_assignments, state.legacyRows.assignments],
    [snapshot.legacy?.tourney_players, state.legacyRows.players],
    [readFullLogicalSnapshotRows(snapshot, "tourney.tourney_player_tokens"), state.sourceRows.tokens],
    [readFullLogicalSnapshotRows(snapshot, "accounts.discord_role_assignments"), state.sourceRows.assignments],
    [readFullLogicalSnapshotRows(snapshot, "tourney.tourney_players"), state.sourceRows.players],
    [readFullLogicalSnapshotRows(snapshot, "accounts.identity_links"), state.sourceRows.identities],
  ];
  requireCondition(comparisons.every(([snapshotRows, currentRows]) =>
    stableJson(normalizeRows(snapshotRows)) === stableJson(normalizeRows(currentRows))
  ), "Live repair rows differ from the verified snapshot.", "LIVE_DRIFT_SNAPSHOT_CHANGED");
  return {
    encryptedSha256: sha256(encrypted),
    snapshotId: snapshot.supabase.snapshotId,
  };
};

const conflictDetails = (state, authorizationHash) => ({
  auditVersion: 1,
  repairVersion: REPAIR_VERSION,
  authorizationHash,
  collisionSourceHash: state.collision.source_hash,
  playerId: state.collision.player_id,
  stalePrincipalId: state.collision.linked_principal_id,
  canonicalDiscordPrincipalId: state.collision.canonical_principal_id,
  discordUserId: state.collision.discord_user_id,
  identityLinkId: state.collision.identity_link_id,
  action: "stale_link_blocked_reauth",
  safeErrorCode: BLOCKED_ERROR_CODE,
});

const insertLegacyConflict = async ({ legacy, conflictId, details, state }) => {
  await legacy.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${REPAIR_VERSION},0))`;
    await assertLiveDriftLegacyDatabaseGate(sql, { allowConflictId: conflictId });
    const tokens = await sql`
      select to_jsonb(row_value) row from tourney_player_tokens row_value order by id
    `;
    const assignments = await sql`
      select to_jsonb(row_value) row from tourney_discord_role_assignments row_value
      order by principal_id
    `;
    const players = await sql`
      select to_jsonb(row_value) row from tourney_players row_value order by id
    `;
    const guards = [
      [tokens.map(({ row }) => row), state.legacyRows.tokens],
      [assignments.map(({ row }) => row), state.legacyRows.assignments],
      [players.map(({ row }) => row), state.legacyRows.players],
    ];
    requireCondition(guards.every(([current, reviewed]) =>
      stableJson(normalizeRows(current)) === stableJson(normalizeRows(reviewed))
    ), "Fallback rows changed after snapshot verification.", "LIVE_DRIFT_FALLBACK_CHANGED");
    await sql`
      insert into tourney_identity_conflicts(
        id,legacy_player_id,principal_id,conflict_type,details
      ) values(
        ${conflictId}::uuid,${state.collision.player_id},
        ${state.collision.linked_principal_id}::uuid,
        'cross_principal_discord_identity',${sql.json(details)}
      ) on conflict(id) do nothing
    `;
    const [row] = await sql`
      select legacy_player_id,principal_id::text principal_id,conflict_type,details,resolved_at
      from tourney_identity_conflicts where id=${conflictId}::uuid for update
    `;
    requireCondition(row && row.resolved_at === null &&
      row.legacy_player_id === state.collision.player_id &&
      row.principal_id === state.collision.linked_principal_id &&
      row.conflict_type === "cross_principal_discord_identity" &&
      stableJson(row.details) === stableJson(details),
    "Fallback conflict audit does not match the repair.", "LIVE_DRIFT_FALLBACK_AUDIT_MISMATCH");
  });
};

export const applyLiveDriftSourceRepair = async ({
  source,
  state,
  authorizationHash,
  expected = EXPECTED_LIVE_DRIFT,
}) => {
  const commandId = `repair:live-drift:${authorizationHash.slice(0, 48)}`;
  const conflictId = buildLiveDriftConflictId(state.collision.source_hash);
  const details = conflictDetails(state, authorizationHash);
  await source.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${REPAIR_VERSION},0))`;
    await assertLiveDriftDatabaseGate(sql);
    const tokenIds = state.tokens.diffs.map((row) => row.id);
    const currentTokens = await sql`
      select to_jsonb(row_value) row from tourney.tourney_player_tokens row_value
      where id in ${sql(tokenIds)} order by id
    `;
    const currentAssignments = await sql`
      select to_jsonb(row_value) row from accounts.discord_role_assignments row_value
      order by principal_id
    `;
    const currentPlayer = await sql`
      select to_jsonb(row_value) row from tourney.tourney_players row_value
      where id=${state.collision.player_id}
    `;
    const currentIdentity = await sql`
      select to_jsonb(row_value) row from accounts.identity_links row_value
      where id=${state.collision.identity_link_id}::uuid
    `;
    const expectedTokens = state.sourceRows.tokens.filter((row) => tokenIds.includes(row.id));
    const expectedPlayer = state.sourceRows.players.filter(
      (row) => row.id === state.collision.player_id
    );
    const expectedIdentity = state.sourceRows.identities.filter(
      (row) => row.id === state.collision.identity_link_id
    );
    const guards = [
      [currentTokens.map(({ row }) => row), expectedTokens],
      [currentAssignments.map(({ row }) => row), state.sourceRows.assignments],
      [currentPlayer.map(({ row }) => row), expectedPlayer],
      [currentIdentity.map(({ row }) => row), expectedIdentity],
    ];
    requireCondition(guards.every(([current, reviewed]) =>
      stableJson(normalizeRows(current)) === stableJson(normalizeRows(reviewed))
    ), "Source rows changed after snapshot verification.", "LIVE_DRIFT_SOURCE_CHANGED");
    const [sequence] = await sql`select coalesce(max(sequence),0)::bigint value from tourney.mirror_outbox`;
    await sql`
      select set_config('roo.tourney_backend','supabase',true),
        set_config('roo.tourney_generation','1',true),
        set_config('roo.tourney_mirror_enabled','1',true),
        set_config('roo.tourney_mirror_apply','0',true),
        set_config('roo.tourney_command_id',${commandId},true)
    `;
    await sql`
      insert into tourney.identity_conflicts(
        id,legacy_player_id,principal_id,conflict_type,details
      ) values(
        ${conflictId}::uuid,${state.collision.player_id},
        ${state.collision.linked_principal_id}::uuid,
        'cross_principal_discord_identity',${sql.json(details)}
      )
    `;
    const repairedTokens = await sql`
      update tourney.tourney_player_tokens set recipient_version=recipient_version
      where id in ${sql(tokenIds)} returning id
    `;
    requireCondition(repairedTokens.length === expected.events.tourney_player_tokens,
      "Token repair row count changed.", "LIVE_DRIFT_TOKEN_WRITE_MISMATCH");
    const repairedPlayer = await sql`
      update tourney.tourney_players set
        discord_user_id=null,discord_oauth_username=null,
        discord_oauth_global_name=null,discord_linked_at=null,
        discord_role_assigned_at=null,discord_role_last_error=${BLOCKED_ERROR_CODE},
        updated_at=now()
      where id=${state.collision.player_id}
        and principal_id=${state.collision.linked_principal_id}::uuid
        and discord_user_id=${state.collision.discord_user_id}
      returning id
    `;
    requireCondition(repairedPlayer.length === 1,
      "Stale player link changed after preflight.", "LIVE_DRIFT_PLAYER_WRITE_MISMATCH");
    const blockedAssignment = await sql`
      update accounts.discord_role_assignments set
        previous_discord_user_id=discord_user_id,
        stale_discord_user_ids=array(
          select distinct value from unnest(
            coalesce(stale_discord_user_ids,'{}'::text[]) || array[discord_user_id]
          ) value where value is not null
        ),
        desired_role='none',
        generation=generation+1,status='blocked_reauth',attempt_count=0,
        lease_id=null,lease_expires_at=null,last_error=${BLOCKED_ERROR_CODE},
        blocked_at=now(),updated_at=now()
      where principal_id=${state.collision.linked_principal_id}::uuid
        and discord_user_id=${state.collision.discord_user_id}
      returning principal_id
    `;
    requireCondition(blockedAssignment.length === 1,
      "Stale Discord assignment changed after preflight.", "LIVE_DRIFT_ASSIGNMENT_WRITE_MISMATCH");
    const otherPrincipalIds = state.discord.source_principal_ids.filter(
      (value) => value !== state.collision.linked_principal_id
    );
    const reemittedAssignments = await sql`
      update accounts.discord_role_assignments set principal_id=principal_id
      where principal_id::text in ${sql(otherPrincipalIds)}
      returning principal_id
    `;
    requireCondition(reemittedAssignments.length === expected.events.discord_role_assignments - 1,
      "Discord re-emission row count changed.", "LIVE_DRIFT_ASSIGNMENT_WRITE_MISMATCH");
    const events = await sql`
      select table_name,status,generation,source_backend,operation,record_key,
        record_data,record_hash,
        record_hash=encode(extensions.digest(
          convert_to(record_data::text,'UTF8'),'sha256'
        ),'hex') hash_valid
      from tourney.mirror_outbox
      where sequence>${sequence.value} and command_id=${commandId}
      order by sequence
    `;
    const counts = Object.fromEntries(Object.keys(expected.events)
      .filter((key) => key !== "total").map((key) => [key, 0]));
    for (const event of events) {
      if (Object.hasOwn(counts, event.table_name)) counts[event.table_name] += 1;
      const keyComplete = event.table_name === "discord_role_assignments"
        ? Boolean(event.record_key?.principal_id)
        : Boolean(event.record_key?.id);
      requireCondition(event.status === "pending" && Number(event.generation) === 1 &&
        event.source_backend === "supabase" && event.operation === "upsert" && keyComplete &&
        event.hash_valid === true,
      "A generated mirror event is invalid.", "LIVE_DRIFT_EVENT_INVALID");
    }
    requireCondition(events.length === expected.events.total &&
      Object.entries(counts).every(([table, count]) => count === expected.events[table]),
    "Repair emitted an unexpected mirror event set.", "LIVE_DRIFT_EVENT_COUNT_MISMATCH");
    await sql`
      update tourney.cutover_metadata set clean_since=null,
        first_zero_drift_at=null,second_zero_drift_at=null,
        clock_last_reset_reason='manual_live_drift_repair',updated_at=now()
      where id='tourney'
    `;
    await sql`
      insert into tourney.cutover_gate_events(event_kind,generation,actor,evidence)
      values('clock_reset',1,${REPAIR_VERSION},${sql.json({
        authorizationHash,
        collisionSourceHash: state.collision.source_hash,
        eventCounts: expected.events,
        safeErrorCode: BLOCKED_ERROR_CODE,
      })})
    `;
  });
  return { commandId, conflictId, details };
};

const readRepairEvents = async (source, commandId) => source`
  select sequence,event_id,table_name,status,generation,record_key,applied_at,
    last_error_code
  from tourney.mirror_outbox where command_id=${commandId} order by sequence
`;

const assertRepairedCanonicalState = async ({ source, legacy, conflictId, details, expected }) => {
  await assertLiveDriftDatabaseGate(source, { allowConflictId: conflictId });
  await assertLiveDriftLegacyDatabaseGate(legacy, { allowConflictId: conflictId });
  const commandId = `repair:live-drift:${details.authorizationHash.slice(0, 48)}`;
  const events = await readRepairEvents(source, commandId);
  requireCondition(events.length === expected.events.total && events.every((event) =>
    event.status === "applied" && Number(event.generation) === 1 && event.applied_at && !event.last_error_code
  ), "Repair mirror events are not fully applied.", "LIVE_DRIFT_EVENTS_NOT_APPLIED");
  const maxAppliedAt = events.reduce((latest, event) =>
    Math.max(latest, Date.parse(event.applied_at)), 0);
  const [parity] = await source`
    select status,created_at from tourney.parity_runs
    where source_backend='supabase' and target_backend='legacy' and generation=1
    order by created_at desc limit 1
  `;
  requireCondition(parity?.status === "clean" && Date.parse(parity.created_at) >= maxAppliedAt,
    "A fresh clean parity pass is required.", "LIVE_DRIFT_PARITY_NOT_CLEAN");
  const legacyRows = await readLegacyRows(legacy);
  const [sourceTokens, sourceAssignments, sourcePlayers] = await Promise.all([
    source`select to_jsonb(row_value) row from tourney.tourney_player_tokens row_value order by id`,
    source`select to_jsonb(row_value) row from accounts.discord_role_assignments row_value order by principal_id`,
    source`select to_jsonb(row_value) row from tourney.tourney_players row_value order by id`,
  ]);
  const comparisons = [
    [sourceTokens.map(({ row }) => row), legacyRows.tokens],
    [sourceAssignments.map(({ row }) => row), legacyRows.assignments],
    [sourcePlayers.map(({ row }) => row), legacyRows.players],
  ];
  requireCondition(comparisons.every(([left, right]) =>
    stableJson(normalizeRows(left)) === stableJson(normalizeRows(right))
  ), "Repaired source and fallback rows are not canonical.", "LIVE_DRIFT_FINAL_PARITY_MISMATCH");
  const [state] = await source`
    select
      player.discord_user_id is null player_unlinked,
      player.discord_linked_at is null player_link_timestamp_cleared,
      player.discord_role_last_error=${BLOCKED_ERROR_CODE} player_blocked,
      assignment.status='blocked_reauth' assignment_blocked,
      assignment.desired_role='none' assignment_role_disabled,
      assignment.last_error=${BLOCKED_ERROR_CODE} assignment_error_safe,
      assignment.discord_user_id=${details.discordUserId} stale_id_retained,
      assignment.previous_discord_user_id=${details.discordUserId} previous_id_retained,
      ${details.discordUserId}=any(assignment.stale_discord_user_ids) stale_history_retained,
      identity.principal_id::text=${details.canonicalDiscordPrincipalId} canonical_identity_preserved,
      not exists(
        select 1 from tourney.external_operations operation
        where operation.command_id=${commandId}
          and operation.operation_kind in ('discord_membership','discord_role_reconcile')
      ) no_discord_operation
    from tourney.tourney_players player
    join accounts.discord_role_assignments assignment
      on assignment.principal_id=player.principal_id
    join accounts.identity_links identity
      on identity.id=${details.identityLinkId}::uuid
    where player.id=${details.playerId}
      and player.principal_id=${details.stalePrincipalId}::uuid
  `;
  requireCondition(state && Object.values(state).every(Boolean),
    "Canonical stale-link resolution is incomplete.", "LIVE_DRIFT_CANONICAL_STATE_INVALID");
  const [sourceConflict] = await source`
    select details,resolved_at from tourney.identity_conflicts where id=${conflictId}::uuid
  `;
  const [legacyConflict] = await legacy`
    select details,resolved_at from tourney_identity_conflicts where id=${conflictId}::uuid
  `;
  const [legacyBlockers] = await legacy`
    select count(*)::integer count from tourney_identity_conflicts
    where resolved_at is null and id<>${conflictId}::uuid
  `;
  const baseDetails = (value) => {
    const { resolution: _resolution, ...base } = value || {};
    return base;
  };
  requireCondition(sourceConflict && legacyConflict &&
    Number(legacyBlockers.count) === 0 &&
    stableJson(baseDetails(sourceConflict.details)) === stableJson(baseDetails(details)) &&
    stableJson(baseDetails(legacyConflict.details)) === stableJson(baseDetails(details)),
  "Conflict audit is not preserved in both databases.", "LIVE_DRIFT_AUDIT_NOT_PRESERVED");
  return { commandId, events };
};

const closeConflictAudits = async ({ source, legacy, conflictId, details }) => {
  const resolution = {
    resolvedBy: REPAIR_VERSION,
    resolution: "canonical_identity_preserved_stale_link_blocked_reauth",
    authorizationHash: details.authorizationHash,
  };
  await legacy.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${REPAIR_VERSION},0))`;
    await sql`
      update tourney_identity_conflicts set
        resolved_at=coalesce(resolved_at,now()),
        details=details||${sql.json({ resolution })}
      where id=${conflictId}::uuid
    `;
  });
  await source.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${REPAIR_VERSION},0))`;
    await sql`
      update tourney.identity_conflicts set
        resolved_at=coalesce(resolved_at,now()),
        details=details||${sql.json({ resolution })}
      where id=${conflictId}::uuid
    `;
    await sql`
      insert into tourney.cutover_gate_events(event_kind,generation,actor,evidence)
      values('clock_reset',1,${REPAIR_VERSION},${sql.json({
        authorizationHash: details.authorizationHash,
        conflictIdHash: sha256(conflictId),
        resolution: resolution.resolution,
      })})
    `;
  });
  const [[sourceConflict], [legacyConflict]] = await Promise.all([
    source`select resolved_at,details->'resolution' resolution
      from tourney.identity_conflicts where id=${conflictId}::uuid`,
    legacy`select resolved_at,details->'resolution' resolution
      from tourney_identity_conflicts where id=${conflictId}::uuid`,
  ]);
  requireCondition(sourceConflict?.resolved_at && legacyConflict?.resolved_at &&
    stableJson(sourceConflict.resolution) === stableJson(resolution) &&
    stableJson(legacyConflict.resolution) === stableJson(resolution),
  "Conflict resolution audit did not close on both databases.", "LIVE_DRIFT_AUDIT_CLOSE_FAILED");
};

const safePreflightOutput = (state, authorizationHash) => ({
  ok: true,
  action: "preflight",
  authorizationHash,
  tokens: {
    source: state.tokens.source_count,
    target: state.tokens.target_count,
    different: state.tokens.different_rows,
    diffSetHash: state.tokens.diff_set_hash,
    idHashes: state.tokens.diffs.map((row) => row.id_hash),
  },
  discord: {
    source: state.discord.source_count,
    target: state.discord.target_count,
    different: state.discord.different_principal_rows + state.discord.source_only,
    diffSetHash: state.discord.diff_set_hash,
  },
  collision: {
    count: state.collision.count,
    sourceHash: state.collision.source_hash,
    playerHash: state.collision.player_hash,
    linkedPrincipalHash: state.collision.linked_principal_hash,
    canonicalPrincipalHash: state.collision.canonical_principal_hash,
    canonicalAuthorityProven: state.collision.authority?.canonical === true,
  },
  plannedMirrorEvents: EXPECTED_LIVE_DRIFT.events,
  contactsDiscord: false,
});

export const main = async (argv = process.argv.slice(2)) => {
  const args = parseLiveDriftArguments(argv);
  loadPrivateEnvironment(args.envPath);
  if (args.useSupabaseDatabaseUrlStdin) {
    await loadSupabaseDatabaseTargetFromStdin();
  }
  const identities = assertRuntimeEnvironment(process.env);
  const authorizationHash = buildLiveDriftAuthorizationHash();
  if (args.action !== "preflight") {
    requireCondition(args.authorizationHash === authorizationHash,
      "Authorization hash does not match the reviewed repair.", "LIVE_DRIFT_AUTHORIZATION_INVALID");
  }
  const source = connect(process.env.SUPABASE_DATABASE_URL, `${REPAIR_VERSION}-source`);
  const legacy = connect(process.env.TOURNEY_DATABASE_URL, `${REPAIR_VERSION}-legacy`);
  try {
    await assertConnectedDatabaseIdentity(
      source,
      identities.sourceIdentity,
      "LIVE_DRIFT_SOURCE_CONNECTION_IDENTITY_INVALID"
    );
    await assertConnectedDatabaseIdentity(
      legacy,
      identities.legacyIdentity,
      "LIVE_DRIFT_LEGACY_CONNECTION_IDENTITY_INVALID"
    );
    if (args.action === "preflight") {
      const state = await inspectLiveDrift({ source, legacy });
      return safePreflightOutput(state, authorizationHash);
    }
    if (args.action === "apply") {
      const expectedConflictId = buildLiveDriftConflictId(EXPECTED_LIVE_DRIFT.collision.sourceHash);
      const state = await inspectLiveDrift({
        source,
        legacy,
        allowConflictId: expectedConflictId,
      });
      const snapshot = await verifySnapshotProof({ snapshotPath: args.snapshotPath, state });
      const conflictId = buildLiveDriftConflictId(state.collision.source_hash);
      const details = conflictDetails(state, authorizationHash);
      await insertLegacyConflict({ legacy, conflictId, details, state });
      const applied = await applyLiveDriftSourceRepair({
        source,state,authorizationHash,
      });
      return {
        ok: true,
        action: "apply",
        authorizationHash,
        commandIdHash: sha256(applied.commandId),
        conflictIdHash: sha256(applied.conflictId),
        snapshotEncryptedSha256: snapshot.encryptedSha256,
        snapshotIdHash: sha256(snapshot.snapshotId),
        emitted: EXPECTED_LIVE_DRIFT.events,
        contactsDiscord: false,
        next: "run_reconciliation_then_finalize",
      };
    }
    const conflictId = buildLiveDriftConflictId(EXPECTED_LIVE_DRIFT.collision.sourceHash);
    const [conflict] = await source`
      select details from tourney.identity_conflicts where id=${conflictId}::uuid
    `;
    requireCondition(conflict?.details?.authorizationHash === authorizationHash,
      "Source repair audit is unavailable.", "LIVE_DRIFT_SOURCE_AUDIT_MISSING");
    const verified = await assertRepairedCanonicalState({
      source,legacy,conflictId,details: conflict.details,expected: EXPECTED_LIVE_DRIFT,
    });
    await closeConflictAudits({ source,legacy,conflictId,details: conflict.details });
    return {
      ok: true,
      action: "finalize",
      authorizationHash,
      commandIdHash: sha256(verified.commandId),
      appliedEvents: verified.events.length,
      collisionResolved: true,
      canonicalPrincipalHash: EXPECTED_LIVE_DRIFT.collision.canonicalPrincipalHash,
      stalePrincipalStatus: "blocked_reauth",
      contactsDiscord: false,
    };
  } finally {
    await Promise.allSettled([source.end({ timeout: 5 }), legacy.end({ timeout: 5 })]);
  }
};

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const safeCode = String(error?.code || "LIVE_DRIFT_REPAIR_FAILED");
    const safeMessage = safeCode.startsWith("LIVE_DRIFT_")
      ? String(error?.message || "Live drift repair failed.")
      : "Live drift repair failed.";
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: safeCode,
      error: safeMessage,
    })}\n`);
    process.exitCode = 1;
  }
}
