import assert from 'node:assert/strict';
import {evaluate, parse} from 'groq-js';

export const createLegacyPayoutClient = (sql) => ({
  async fetch(query, params = {}) {
    const rows = await sql`
      select payload from migration.source_documents
      where document_type = 'booking' and not tombstoned
      order by legacy_sanity_id
    `;
    const result = await evaluate(parse(query), {
      dataset: rows.map(row => row.payload),
      params,
    });
    return result.get();
  },
});

export const checkPayoutReadScale = async ({sql, seed, summary}) => {
  const state = await seed('dodo', {booking: false, amount: 1, rate: 1});
  const count = 1100;
  await sql`
    insert into migration.source_documents (
      legacy_sanity_id, document_type, source_revision, source_hash, payload
    )
    select
      ${state.key} || '.history.' || index,
      'booking',
      'scale-history',
      repeat('a', 64),
      jsonb_build_object(
        '_id', ${state.key} || '.history.' || index,
        '_type', 'booking',
        'status', case when index % 2 = 0 then 'captured' else 'completed' end,
        'packageTitle', ${state.packageDoc.title}::text,
        'referral', jsonb_build_object('_type', 'reference', '_ref', ${state.creator._id}::text),
        'referralCode', ${state.key}::text,
        'grossAmount', 1,
        'netAmount', 1,
        'commissionPercent', 1,
        'commissionAmount', 0.01,
        'commissionCalculationVersion', 2
      )
    from generate_series(1, ${count}) as history(index)
  `;
  await sql`select public.roo_project_operational_shadow()`;
  const rows = await sql`
    select payload from migration.source_documents
    where document_type = 'booking' and payload->>'referralCode' = ${state.key}
      and not tombstoned
    order by legacy_sanity_id
  `;
  const bytes = Buffer.byteLength(JSON.stringify(rows.map(row => row.payload)));
  const firstPageBytes = Buffer.byteLength(JSON.stringify(rows.slice(0, 1000).map(row => row.payload)));
  assert.equal(rows.length, count);
  assert.ok(firstPageBytes > 250 * 1024);
  const earnings = await summary(state.creator, 11);
  return {count, bytes, firstPageBytes, earnings};
};
