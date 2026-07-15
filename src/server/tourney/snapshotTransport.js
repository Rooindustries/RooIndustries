import crypto from "node:crypto";
import { createClient as createSanityClient } from "@sanity/client";
import postgres from "postgres";
import migrationTargetSafety from "../supabase/migrationTargetSafety.cjs";
import { buildTourneyPostgresOptions } from "./sqlClient.js";
import {
  SUPABASE_FULL_REQUIRED_RELATIONS,
  SUPABASE_FULL_SNAPSHOT_SCHEMAS,
  stableSnapshotJson,
  TOURNEY_HOSTED_SNAPSHOT_RELATIONS,
  TOURNEY_LEGACY_SNAPSHOT_TABLES,
  validateFullLogicalSnapshot,
} from "./snapshotContract.js";

const {
  assertTourneyCutoverLegacyTarget,
  assertTourneyCutoverSanityTarget,
  assertTourneyCutoverSupabaseApiTarget,
  assertTourneyCutoverSupabaseDatabaseTarget,
  computeTourneyCutoverSupabaseDatabaseTargetFingerprint,
  expectedConnectedDatabaseUsername,
} = migrationTargetSafety;

export const SNAPSHOT_TRANSPORT_CHUNK_BYTES = 512 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalize = (value) => String(value || "").trim();
const enabled = (value) => ["1", "true", "yes", "on"].includes(
  normalize(value).toLowerCase()
);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const failure = (code) => Object.assign(
  new Error("Tourney snapshot transport is not ready."),
  { code, status: 503 }
);

export const resolveSnapshotLegacyDatabaseUrl = (env = process.env) => {
  const dedicated = normalize(env.TOURNEY_DATABASE_URL);
  const managed = normalize(env.POSTGRES_URL);
  if (dedicated && managed) {
    let dedicatedFingerprint;
    let managedFingerprint;
    try {
      dedicatedFingerprint = migrationTargetSafety
        .computeTourneyCutoverLegacyTargetFingerprint(dedicated);
      managedFingerprint = migrationTargetSafety
        .computeTourneyCutoverLegacyTargetFingerprint(managed);
    } catch {
      throw failure("TOURNEY_SNAPSHOT_LEGACY_TARGET_INVALID");
    }
    if (dedicatedFingerprint !== managedFingerprint) {
      throw failure("TOURNEY_SNAPSHOT_LEGACY_TARGET_AMBIGUOUS");
    }
  }
  const selected = dedicated || managed;
  if (!selected) throw failure("TOURNEY_SNAPSHOT_LEGACY_TARGET_MISSING");
  return selected;
};

const sanityTarget = (env) => ({
  projectId: normalize(
    env.SANITY_PRIVATE_PROJECT_ID || env.SANITY_PROJECT_ID ||
    env.NEXT_PUBLIC_SANITY_PROJECT_ID
  ),
  dataset: normalize(
    env.SANITY_PRIVATE_DATASET || env.SANITY_DATASET ||
    env.NEXT_PUBLIC_SANITY_DATASET || "production"
  ),
});

const supabaseApiUrl = (env) => normalize(
  env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL
);

const assertExpectedTargets = ({ env, expectedTargets, requireDatabasePin }) => {
  const legacyDatabaseUrl = resolveSnapshotLegacyDatabaseUrl(env);
  const sanity = sanityTarget(env);
  const apiUrl = supabaseApiUrl(env);
  const databaseUrl = normalize(env.SUPABASE_DATABASE_URL);
  if (!databaseUrl) throw failure("TOURNEY_SNAPSHOT_SUPABASE_DATABASE_MISSING");
  const legacy = assertTourneyCutoverLegacyTarget({
    databaseUrl: legacyDatabaseUrl,
    expectedFingerprint: expectedTargets?.legacy,
  });
  const sanityIdentity = assertTourneyCutoverSanityTarget({
    ...sanity,
    expectedFingerprint: expectedTargets?.sanity,
  });
  const api = assertTourneyCutoverSupabaseApiTarget({
    supabaseUrl: apiUrl,
    expectedFingerprint: expectedTargets?.supabaseApi,
  });
  const databaseFingerprint = computeTourneyCutoverSupabaseDatabaseTargetFingerprint({
    databaseUrl,
    supabaseUrl: apiUrl,
  });
  const database = assertTourneyCutoverSupabaseDatabaseTarget({
    databaseUrl,
    supabaseUrl: apiUrl,
    expectedFingerprint: requireDatabasePin
      ? expectedTargets?.supabaseDatabase
      : databaseFingerprint,
  });
  return {
    connections: { apiUrl, databaseUrl, legacyDatabaseUrl, sanity },
    fingerprints: {
      legacy: legacy.fingerprint,
      sanity: sanityIdentity.fingerprint,
      supabaseApi: api.fingerprint,
      supabaseDatabase: database.fingerprint,
    },
    identities: { database, legacy },
  };
};

export const assertConnectedSnapshotIdentity = async ({ sql, expected, code }) => {
  const [row] = await sql`
    select pg_catalog.current_database() database, current_user username
  `;
  if (
    row?.database !== expected.database ||
    row?.username !== expectedConnectedDatabaseUsername(expected)
  ) {
    throw failure(code);
  }
};

const createSql = ({
  backend,
  databaseUrl,
  applicationName,
  statementTimeout = 120000,
}) => postgres({
  ...buildTourneyPostgresOptions({ backend, databaseUrl }),
  max: 1,
  connection: {
    application_name: applicationName,
    search_path: backend === "supabase" ? "tourney,public" : "public",
    statement_timeout: statementTimeout,
    lock_timeout: 5000,
  },
});

const legacySnapshotQuery = () => {
  const pairs = TOURNEY_LEGACY_SNAPSHOT_TABLES.flatMap((table) => [
    `'${table}'`,
    `coalesce((select jsonb_agg(to_jsonb(source_row) order by to_jsonb(source_row)::text) from "${table}" source_row), '[]'::jsonb)`,
  ]).join(",\n");
  return `select jsonb_build_object(${pairs})::text payload_text`;
};

const readLegacySnapshot = async (sql) => sql.begin(
  "isolation level repeatable read read only",
  async (transaction) => {
    const tables = TOURNEY_LEGACY_SNAPSHOT_TABLES.map((table) => `'${table}'`).join(",");
    const [missing] = await transaction.unsafe(`
      select coalesce(jsonb_agg(name order by name), '[]'::jsonb) missing
      from unnest(array[${tables}]::text[]) name
      where to_regclass(name) is null
    `);
    if (Array.isArray(missing?.missing) && missing.missing.length > 0) {
      throw failure("TOURNEY_SNAPSHOT_LEGACY_SCHEMA_INCOMPLETE");
    }
    const [row] = await transaction.unsafe(legacySnapshotQuery());
    const payloadText = normalize(row?.payload_text);
    let data;
    try {
      data = JSON.parse(payloadText);
    } catch {
      throw failure("TOURNEY_SNAPSHOT_LEGACY_PAYLOAD_INVALID");
    }
    if (TOURNEY_LEGACY_SNAPSHOT_TABLES.some((table) => !Array.isArray(data[table]))) {
      throw failure("TOURNEY_SNAPSHOT_LEGACY_PAYLOAD_INVALID");
    }
    return { data, payloadText };
  }
);

const readSanityAccount = async ({ env, target }) => {
  const token = normalize(
    env.SANITY_PRIVATE_READ_TOKEN || env.SANITY_READ_TOKEN ||
    env.SANITY_PRIVATE_WRITE_TOKEN || env.SANITY_WRITE_TOKEN
  );
  if (!token) throw failure("TOURNEY_SNAPSHOT_SANITY_TOKEN_MISSING");
  const client = createSanityClient({
    ...target,
    token,
    useCdn: false,
    perspective: "raw",
    apiVersion: normalize(env.SANITY_API_VERSION) || "2023-10-01",
  });
  const account = await client.fetch(
    `*[_id == "tourneyAuthStore"][0]`,
    {},
    { cache: "no-store" }
  );
  if (!account || account._id !== "tourneyAuthStore") {
    throw failure("TOURNEY_SNAPSHOT_SANITY_ACCOUNT_MISSING");
  }
  return account;
};

const validateHostedCapture = ({ proof, legacy, sanityAccount }) => {
  const payloadText = typeof proof?.payload_text === "string" ? proof.payload_text : "";
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    payload = null;
  }
  const valid =
    UUID.test(String(proof?.snapshot_id || "")) &&
    SHA256.test(String(proof?.payload_sha256 || "")) &&
    proof?.hosted_roundtrip_verified === true &&
    sha256(payloadText) === proof.payload_sha256 &&
    payload && stableSnapshotJson(payload.legacy) === stableSnapshotJson(legacy) &&
    stableSnapshotJson(payload.sanity_account) === stableSnapshotJson(sanityAccount) &&
    TOURNEY_HOSTED_SNAPSHOT_RELATIONS.every((relation) =>
      Array.isArray(payload[relation]) &&
      Number(proof.table_counts?.[relation]) === payload[relation].length
    );
  if (!valid) throw failure("TOURNEY_SNAPSHOT_HOSTED_PROOF_INVALID");
  return { payloadText, totalBytes: Buffer.byteLength(payloadText) };
};

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

const readFullLogicalRelations = async (transaction) => {
  const schemaList = SUPABASE_FULL_SNAPSHOT_SCHEMAS
    .map((schema) => `'${schema}'`)
    .join(",");
  const catalogRows = await transaction.unsafe(`
    select namespace.nspname schema_name, relation.relname relation_name
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname in (${schemaList})
      and relation.relkind in ('r','p')
      and not relation.relispartition
    order by namespace.nspname,relation.relname
  `);
  const relationPayloads = {};
  const relationCounts = {};
  for (const relation of catalogRows) {
    const name = `${relation.schema_name}.${relation.relation_name}`;
    const qualified = `${quoteIdentifier(relation.schema_name)}.${quoteIdentifier(
      relation.relation_name
    )}`;
    const [row] = await transaction.unsafe(`
      select coalesce(
        jsonb_agg(to_jsonb(source_row) order by to_jsonb(source_row)::text),
        '[]'::jsonb
      )::text rows_text,
      count(*)::integer row_count
      from ${qualified} source_row
    `);
    if (
      typeof row?.rows_text !== "string" ||
      !Number.isSafeInteger(row?.row_count) || row.row_count < 0
    ) {
      throw failure("TOURNEY_SNAPSHOT_LOGICAL_RELATION_INVALID");
    }
    relationPayloads[name] = row.rows_text;
    relationCounts[name] = row.row_count;
  }
  const [vaultRow] = await transaction`
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',secret.id,
          'decrypted_secret',secret.decrypted_secret
        )
        order by secret.id::text
      ),
      '[]'::jsonb
    )::text rows_text,
    count(*)::integer row_count
    from vault.decrypted_secrets secret
    where secret.id in (
      select distinct snapshot.key_secret_id
      from migration.tourney_pre_cutover_snapshots snapshot
    )
  `;
  if (
    typeof vaultRow?.rows_text !== "string" ||
    !Number.isSafeInteger(vaultRow?.row_count) || vaultRow.row_count < 0
  ) {
    throw failure("TOURNEY_SNAPSHOT_VAULT_KEYS_INVALID");
  }
  relationPayloads["vault.tourney_snapshot_keys"] = vaultRow.rows_text;
  relationCounts["vault.tourney_snapshot_keys"] = vaultRow.row_count;
  return { relationCounts, relationPayloads };
};

export const captureFullLogicalSnapshotTransaction = async ({
  transaction,
  partialProof,
  partialPayloadText,
}) => {
  const { relationCounts, relationPayloads } = await readFullLogicalRelations(transaction);
  const relationHashes = {};
  for (const [relation, rowsText] of Object.entries(relationPayloads)) {
    relationHashes[relation] = sha256(rowsText);
  }
  const [clock] = await transaction`
    select pg_catalog.transaction_timestamp() captured_at
  `;
  const fullLogical = {
    format: "roo-supabase-full-logical-snapshot-v1",
    capturedAt: new Date(clock.captured_at).toISOString(),
    sourceSnapshotId: partialProof.snapshot_id,
    schemas: [...SUPABASE_FULL_SNAPSHOT_SCHEMAS],
    requiredRelations: [...SUPABASE_FULL_REQUIRED_RELATIONS],
    relationPayloads,
    relationCounts,
    relationHashes,
  };
  const trimmedPartial = String(partialPayloadText || "").trim();
  if (!trimmedPartial.startsWith("{") || !trimmedPartial.endsWith("}")) {
    throw failure("TOURNEY_SNAPSHOT_HOSTED_PROOF_INVALID");
  }
  const payloadText = `${trimmedPartial.slice(0, -1)},"full_logical":${
    stableSnapshotJson(fullLogical)
  }}`;
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    payload = null;
  }
  const validation = validateFullLogicalSnapshot(payload, { hash: sha256 });
  const payloadSha256 = sha256(payloadText);
  const key = crypto.randomBytes(32).toString("hex");
  const keyName = `tourney-full-logical-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const [secret] = await transaction`
    select vault.create_secret(
      ${key},
      ${keyName},
      'AES key for a Roo Industries full logical rollback snapshot'
    ) key_id
  `;
  if (!UUID.test(String(secret?.key_id || ""))) {
    throw failure("TOURNEY_SNAPSHOT_VAULT_KEY_CREATE_FAILED");
  }
  const tableCounts = {
    ...partialProof.table_counts,
    ...relationCounts,
  };
  const [stored] = await transaction`
    insert into migration.tourney_pre_cutover_snapshots(
      key_secret_id,payload_sha256,ciphertext,table_counts
    ) values(
      ${secret.key_id}::uuid,
      ${payloadSha256},
      extensions.pgp_sym_encrypt(
        ${payloadText},
        ${key},
        'cipher-algo=aes256,compress-algo=1'
      ),
      ${transaction.json(tableCounts)}::jsonb
    )
    returning id,captured_at
  `;
  const [roundtrip] = await transaction`
    select
      secret.decrypted_secret vault_key,
      extensions.pgp_sym_decrypt(snapshot.ciphertext,secret.decrypted_secret) payload_text
    from migration.tourney_pre_cutover_snapshots snapshot
    join vault.decrypted_secrets secret on secret.id=snapshot.key_secret_id
    where snapshot.id=${stored.id}::uuid
  `;
  if (
    roundtrip?.vault_key !== key ||
    roundtrip?.payload_text !== payloadText ||
    sha256(String(roundtrip?.payload_text || "")) !== payloadSha256
  ) {
    throw failure("TOURNEY_SNAPSHOT_FULL_ROUNDTRIP_FAILED");
  }
  return {
    snapshotId: stored.id,
    capturedAt: stored.captured_at,
    payloadSha256,
    totalBytes: Buffer.byteLength(payloadText),
    tableCounts,
    validation,
  };
};

const assertSnapshotRuntime = (env) => {
  const hardened = enabled(env.TOURNEY_HARDENING_V4_ENABLED);
  const activation = enabled(env.TOURNEY_V4_ACTIVATION_ENABLED) && !hardened;
  if (
    normalize(env.TOURNEY_DATABASE_MODE).toLowerCase() !== "supabase" ||
    !enabled(env.TOURNEY_MIRROR_ENABLED) || !enabled(env.TOURNEY_WRITES_PAUSED) ||
    normalize(env.TOURNEY_FAILOVER_GENERATION) !== "1" ||
    (!hardened && !activation)
  ) {
    throw failure("TOURNEY_SNAPSHOT_RUNTIME_NOT_PAUSED");
  }
};

export const inspectSnapshotTransport = async ({
  env = process.env,
  expectedTargets,
} = {}) => {
  const checked = assertExpectedTargets({
    env,
    expectedTargets,
    requireDatabasePin: false,
  });
  const legacy = createSql({
    backend: "legacy",
    databaseUrl: checked.connections.legacyDatabaseUrl,
    applicationName: "roo-tourney-snapshot-inspect-legacy",
  });
  const supabase = createSql({
    backend: "supabase",
    databaseUrl: checked.connections.databaseUrl,
    applicationName: "roo-tourney-snapshot-inspect-supabase",
  });
  try {
    await Promise.all([
      assertConnectedSnapshotIdentity({
        sql: legacy,
        expected: checked.identities.legacy,
        code: "TOURNEY_SNAPSHOT_LEGACY_IDENTITY_MISMATCH",
      }),
      assertConnectedSnapshotIdentity({
        sql: supabase,
        expected: checked.identities.database,
        code: "TOURNEY_SNAPSHOT_SUPABASE_IDENTITY_MISMATCH",
      }),
    ]);
    return { fingerprints: checked.fingerprints };
  } finally {
    await Promise.allSettled([
      legacy.end({ timeout: 5 }),
      supabase.end({ timeout: 5 }),
    ]);
  }
};

export const captureSnapshotTransport = async ({
  env = process.env,
  expectedTargets,
} = {}) => {
  assertSnapshotRuntime(env);
  const checked = assertExpectedTargets({
    env,
    expectedTargets,
    requireDatabasePin: true,
  });
  const legacySql = createSql({
    backend: "legacy",
    databaseUrl: checked.connections.legacyDatabaseUrl,
    applicationName: "roo-tourney-snapshot-capture-legacy",
  });
  const supabaseSql = createSql({
    backend: "supabase",
    databaseUrl: checked.connections.databaseUrl,
    applicationName: "roo-tourney-snapshot-capture-supabase",
    statementTimeout: 240000,
  });
  try {
    await Promise.all([
      assertConnectedSnapshotIdentity({
        sql: legacySql,
        expected: checked.identities.legacy,
        code: "TOURNEY_SNAPSHOT_LEGACY_IDENTITY_MISMATCH",
      }),
      assertConnectedSnapshotIdentity({
        sql: supabaseSql,
        expected: checked.identities.database,
        code: "TOURNEY_SNAPSHOT_SUPABASE_IDENTITY_MISMATCH",
      }),
    ]);
    const [legacy, sanityAccount] = await Promise.all([
      readLegacySnapshot(legacySql),
      readSanityAccount({ env, target: checked.connections.sanity }),
    ]);
    const capture = await supabaseSql.begin(
      "isolation level repeatable read",
      async (transaction) => {
        const [row] = await transaction`
          select public.roo_capture_tourney_hardening_snapshot(
            null::jsonb,
            ${transaction.json(sanityAccount)}::jsonb,
            ${legacy.payloadText}::text
          ) proof
        `;
        const hosted = validateHostedCapture({
          proof: row?.proof,
          legacy: legacy.data,
          sanityAccount,
        });
        return captureFullLogicalSnapshotTransaction({
          transaction,
          partialProof: row.proof,
          partialPayloadText: hosted.payloadText,
        });
      }
    );
    return {
      snapshotId: capture.snapshotId,
      payloadSha256: capture.payloadSha256,
      totalBytes: capture.totalBytes,
      tableCounts: capture.tableCounts,
      capturedAt: capture.capturedAt,
      fingerprints: checked.fingerprints,
      legacyPayloadSha256: sha256(legacy.payloadText),
      sanityAccountSha256: sha256(stableSnapshotJson(sanityAccount)),
      hostedRoundtripVerified: true,
      fullLogicalVerified: true,
      fullLogicalRelations: capture.validation.relationCount,
      fullLogicalRows: capture.validation.rowCount,
    };
  } finally {
    await Promise.allSettled([
      legacySql.end({ timeout: 5 }),
      supabaseSql.end({ timeout: 5 }),
    ]);
  }
};

export const readSnapshotTransportChunk = async ({
  env = process.env,
  expectedTargets,
  snapshotId,
  payloadSha256,
  offset,
} = {}) => {
  assertSnapshotRuntime(env);
  const checked = assertExpectedTargets({
    env,
    expectedTargets,
    requireDatabasePin: true,
  });
  if (
    !UUID.test(String(snapshotId || "")) ||
    !SHA256.test(String(payloadSha256 || "")) ||
    !Number.isSafeInteger(offset) || offset < 0
  ) {
    throw failure("TOURNEY_SNAPSHOT_CHUNK_REQUEST_INVALID");
  }
  const sql = createSql({
    backend: "supabase",
    databaseUrl: checked.connections.databaseUrl,
    applicationName: "roo-tourney-snapshot-read-chunk",
  });
  try {
    await assertConnectedSnapshotIdentity({
      sql,
      expected: checked.identities.database,
      code: "TOURNEY_SNAPSHOT_SUPABASE_IDENTITY_MISMATCH",
    });
    const [row] = await sql`
      with decrypted as (
        select
          snapshot.payload_sha256,
          pg_catalog.convert_to(
            extensions.pgp_sym_decrypt(snapshot.ciphertext, secret.decrypted_secret),
            'UTF8'
          ) payload
        from migration.tourney_pre_cutover_snapshots snapshot
        join vault.decrypted_secrets secret on secret.id=snapshot.key_secret_id
        where snapshot.id=${snapshotId}::uuid
          and snapshot.payload_sha256=${payloadSha256}
      )
      select
        payload_sha256,
        pg_catalog.octet_length(payload)::integer total_bytes,
        pg_catalog.encode(
          pg_catalog.substring(
            payload from ${offset + 1} for ${SNAPSHOT_TRANSPORT_CHUNK_BYTES}
          ),
          'base64'
        ) chunk
      from decrypted
    `;
    const totalBytes = Number(row?.total_bytes);
    const chunk = Buffer.from(String(row?.chunk || ""), "base64");
    if (
      !Number.isSafeInteger(totalBytes) || totalBytes < 1 || offset >= totalBytes ||
      chunk.byteLength < 1 || chunk.byteLength > SNAPSHOT_TRANSPORT_CHUNK_BYTES ||
      offset + chunk.byteLength > totalBytes
    ) {
      throw failure("TOURNEY_SNAPSHOT_CHUNK_UNAVAILABLE");
    }
    return {
      chunk,
      totalBytes,
      fingerprints: checked.fingerprints,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
};
