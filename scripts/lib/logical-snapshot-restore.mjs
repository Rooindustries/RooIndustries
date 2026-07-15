import crypto from "node:crypto";
import { validateFullLogicalSnapshot } from "../../src/server/tourney/snapshotContract.js";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export const verifyFullLogicalSnapshotRestore = async ({ sql, payload }) => {
  const before = validateFullLogicalSnapshot(payload, { hash: sha256 });
  return sql.begin(async (transaction) => {
    const [version] = await transaction`
      select pg_catalog.current_setting('server_version_num')::integer version_num
    `;
    if (Number(version?.version_num) < 170000) {
      throw Object.assign(
        new Error("PostgreSQL 17 or newer is required for restore verification."),
        { code: "SNAPSHOT_RESTORE_POSTGRES_VERSION_UNSUPPORTED" }
      );
    }
    await transaction`
      create temporary table snapshot_restore_relations(
        relation_name text primary key,
        expected_count integer not null,
        expected_hash text not null
      ) on commit drop
    `;
    await transaction`
      create temporary table snapshot_restore_rows(
        relation_name text not null references snapshot_restore_relations(relation_name),
        row_index integer not null,
        payload jsonb not null,
        primary key(relation_name,row_index)
      ) on commit drop
    `;
    const logical = payload.full_logical;
    for (const relation of before.relationNames) {
      await transaction`
        insert into snapshot_restore_relations(
          relation_name,expected_count,expected_hash
        ) values(
          ${relation},
          ${logical.relationCounts[relation]},
          ${logical.relationHashes[relation]}
        )
      `;
      await transaction`
        insert into snapshot_restore_rows(relation_name,row_index,payload)
        select ${relation},(entry.ordinality - 1)::integer,entry.value
        from jsonb_array_elements(
          ${transaction.typed(logical.relationPayloads[relation], 25)}::jsonb
        )
          with ordinality entry(value,ordinality)
      `;
    }
    const manifest = await transaction`
      select
        relation.relation_name,
        relation.expected_count,
        relation.expected_hash,
        coalesce(
          jsonb_agg(row.payload order by row.row_index)
            filter(where row.row_index is not null),
          '[]'::jsonb
        )::text rows_text,
        count(row.row_index)::integer row_count
      from snapshot_restore_relations relation
      left join snapshot_restore_rows row
        on row.relation_name=relation.relation_name
      group by
        relation.relation_name,
        relation.expected_count,
        relation.expected_hash
      order by relation.relation_name
    `;
    if (manifest.length !== before.relationCount) {
      throw Object.assign(
        new Error("The PostgreSQL restore manifest is incomplete."),
        { code: "SNAPSHOT_RESTORE_MANIFEST_INCOMPLETE" }
      );
    }
    for (const relation of manifest) {
      if (
        relation.row_count !== relation.expected_count ||
        sha256(relation.rows_text) !== relation.expected_hash ||
        relation.rows_text !== logical.relationPayloads[relation.relation_name]
      ) {
        throw Object.assign(
          new Error("A PostgreSQL-restored relation failed canonical validation."),
          { code: "SNAPSHOT_RESTORE_RELATION_MISMATCH" }
        );
      }
    }
    return {
      postgresVersionNum: Number(version.version_num),
      relationCount: before.relationCount,
      rowCount: before.rowCount,
      canonicalRoundtripVerified: true,
    };
  });
};
