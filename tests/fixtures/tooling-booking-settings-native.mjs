import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSweepPostgresFixture } from '../../scripts/lib/sweep-postgres-fixture.mjs';

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith(new URL('../../src/', import.meta.url).href)) {
    const candidate = new URL(specifier, context.parentURL);
    if (!path.extname(candidate.pathname) && fs.existsSync(fileURLToPath(candidate) + '.js')) return next(candidate.href + '.js', context);
  }
  return next(specifier, context);
} });
const { createSupabaseDocumentClient } = await import('../../src/server/supabase/documentClient.js');
const { getBookingSettings } = await import('../../src/server/booking/slotPolicy.js');
const fixture = await createSweepPostgresFixture();
const id = '6d8a3646-0ed2-44b5-ad45-c5c9d578126a';
const firstPackage = '0a000000-0000-4000-8000-000000000001';
const lastPackage = 'fa000000-0000-4000-8000-000000000002';
const client = createSupabaseDocumentClient({ shadowClient: fixture.client, commerceOnly: true });
const evidence = { postgresVersion: fixture.postgresVersion, postgrestVersion: fixture.postgrestVersion, origin: fixture.origin, scratch: fixture.scratch, manifest: fixture.manifest, scenarios: [], servicesStopped: false, standIn: 'Native PostgreSQL17/PostgREST and actual production SupabaseDocumentClient/getBookingSettings. Auth/storage bootstrap/grants are local stand-ins; hosted schema/RLS/GoTrue not proved.' };
const check = async (name, action) => {
  try { evidence.scenarios.push({ name, passed: true, proof: await action() }); }
  catch (error) { evidence.scenarios.push({ name, passed: false, error: error.message }); }
};
const put = async document => {
  await fixture.sql`insert into migration.source_documents(legacy_sanity_id,document_type,payload,source_revision,source_created_at,source_updated_at,source_hash,tombstoned)
  values(${document._id},${document._type},${fixture.sql.json(document)},'native-fixture-r1',now(),now(),${createHash('sha256').update(JSON.stringify(document)).digest('hex')},false)
  on conflict(legacy_sanity_id) do update set payload=excluded.payload,source_hash=excluded.source_hash`;
};
try {
  await put({ _id: firstPackage, _type: 'package', title: 'Earlier synthetic package' });
  await put({ _id: lastPackage, _type: 'package', title: 'Later synthetic package' });
  const settings = { _id: id, _type: 'bookingSettings', dateSlots: [{ date: '2099-01-05', times: ['10:00', '11:00'] }], xocDateSlots: [], vertexEssentialsDateSlots: [], packageDateSlots: [] };
  await put(settings);
  await check('earlier-package-does-not-hide-exact-booking-settings-id', async () => {
    const output = await getBookingSettings({ client });
    assert.deepEqual(output.dateSlots, settings.dateSlots);
    return { settingsId: id, earlierPackageId: firstPackage, actual: output };
  });
  await put({ ...settings, packageDateSlots: [{ _key: 'earlier', package: { _type: 'reference', _ref: firstPackage }, dateSlots: [{ date: '2099-01-06', times: ['12:00'] }] }, { _key: 'later', package: { _type: 'reference', _ref: lastPackage }, dateSlots: [{ date: '2099-01-07', times: ['13:00'] }] }] });
  await check('joined-settings-preserve-both-referenced-package-slot-maps', async () => {
    const output = await getBookingSettings({ client });
    assert.deepEqual(output.packageDateSlots.map(row => row.package), [{ _id: firstPackage, title: 'Earlier synthetic package' }, { _id: lastPackage, title: 'Later synthetic package' }]);
    assert.deepEqual(output.packageDateSlots.map(row => row.dateSlots), [[{ date: '2099-01-06', times: ['12:00'] }], [{ date: '2099-01-07', times: ['13:00'] }]]);
    return output;
  });
  await fixture.sql`update migration.source_documents set tombstoned=true where legacy_sanity_id=${lastPackage}`;
  await check('tombstoned-reference-does-not-create-package-availability', async () => {
    const output = await getBookingSettings({ client });
    assert.deepEqual(output.packageDateSlots.map(row => row.package._id), [firstPackage]);
    return output;
  });
  const manyPackages = Array.from({ length: 1001 }, (_, index) => ({ _id: `t-${String(index).padStart(4, '0')}`, _type: 'package', title: `Synthetic ${index}` }));
  for (const pkg of manyPackages) await put(pkg);
  await put({ ...settings, packageDateSlots: manyPackages.map(pkg => ({ package: { _type: 'reference', _ref: pkg._id }, dateSlots: [{ date: '2099-01-08', times: ['14:00'] }] })) });
  await check('1001-references-preserve-last-custom-slot-map-within-payload-budget', async () => {
    const output = await getBookingSettings({ client });
    assert.equal(output.packageDateSlots.length, 1001);
    assert.deepEqual(output.packageDateSlots.at(-1), { package: { _id: 't-1000', title: 'Synthetic 1000' }, dateSlots: [{ date: '2099-01-08', times: ['14:00'] }] });
    return { entries: output.packageDateSlots.length, finalEntry: output.packageDateSlots.at(-1) };
  });
  await fixture.sql`update migration.source_documents set tombstoned=true where legacy_sanity_id=${id}`;
  await check('missing-settings-refuse-instead-of-reading-unrelated-package', async () => {
    await assert.rejects(getBookingSettings({ client }), /Missing booking settings/);
    return { settingsId: id, tombstoned: true };
  });
} finally {
  evidence.requests = fixture.requestLog;
  await fixture.stop(); evidence.servicesStopped = true;
  const output = process.env.TOOLING_BOOKING_ARTIFACT || 'test-results/fix-h/booking-settings-native.json';
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ output, passed: evidence.scenarios.filter(row => row.passed).length, total: evidence.scenarios.length }));
}
if (evidence.scenarios.some(row => !row.passed)) process.exitCode = 1;
