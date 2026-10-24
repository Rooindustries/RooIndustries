import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { installNetworkGuard, refuseEnvFiles } from './lib/test-target-safety.mjs';
import { createSweepPostgresFixture } from './lib/sweep-postgres-fixture.mjs';
import { createRamPriceFixture } from '../tests/fixtures/ram-price.mjs';

refuseEnvFiles();
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.js`, context);
    throw error;
  }
} });
const { refreshRamPrice } = await import('../src/server/content/refreshRamPrice.js');
const { executeGlobalCmsCommand } = await import('../src/server/cms/publishCommand.js');
const { createSupabaseAdminClient } = await import('../src/server/supabase/adminClient.js');
const host = process.env.ROO_TEST_HOST || '127.0.0.1';
const port = Number(process.env.ROO_RAM_PRICE_NATIVE_PORT || 41480);
assert.ok(Number.isInteger(port) && port >= 1024 && port < 65532);
const restore = installNetworkGuard([1, 2, 3].map(offset => `http://${host}:${port + offset}`));
const result = {};
let fixture, sourceServer;
try {
  fixture = await createSweepPostgresFixture({ fullMigrationChain: true, ports: { postgres: port, rest: port + 1, proxy: port + 2 } });
  result.postgres = fixture.postgresVersion;
  result.migrations = fixture.manifest.length;
  const documents = [
    { _id: 'native-ram-hero', _type: 'hero', _rev: 'seed', headingLine1: 'Editor heading' },
    { _id: 'native-ram-package', _type: 'package', title: 'Performance Vertex Max', price: '$149.95' },
  ];
  const source = createRamPriceFixture({ documents });
  sourceServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    if (!await source({ url: new URL(request.url, `http://${host}:${port + 3}`), body: raw.length ? JSON.parse(raw) : {}, res: response })) {
      response.writeHead(404); response.end();
    }
  });
  sourceServer.listen(port + 3, host);
  await once(sourceServer, 'listening');
  const seeded = await fixture.client.rpc('roo_apply_document_mutations', { p_mutations: documents.map(document => ({ operation: 'create', document })) });
  assert.equal(seeded.error, null);
  const env = { SUPABASE_URL: fixture.origin, SUPABASE_SECRET_KEY: fixture.token, VERCEL_ENV: 'preview', TOOLING_NETWORK_GUARD: '1', HERO_RAM_PRICE_SOURCE_URL: `http://${host}:${port + 3}/storefront`, CRON_SECRET: 'fixture-native-cron', CMS_WRITES_PAUSED: '0' };
  const [packageBefore] = await fixture.sql`select payload from migration.source_documents where legacy_sanity_id='native-ram-package'`;
  const refresh = await refreshRamPrice({ client: fixture.client, env, signal: AbortSignal.timeout(20000) });
  assert.equal(refresh.state, 'updated');
  const [saved] = await fixture.sql`select payload from migration.source_documents where legacy_sanity_id='native-ram-hero'`;
  assert.equal(saved.payload.ramPrice.priceCents, 50000);
  assert.equal(saved.payload.headingLine1, documents[0].headingLine1);
  assert.equal((await refreshRamPrice({ client: fixture.client, env })).state, 'fresh');
  await executeGlobalCmsCommand({ supabaseClient: fixture.client, env, actor: 'admin:key', body: {
    operation: 'replace', type: 'hero', documentId: saved.payload._id, expectedRevision: saved.payload._rev,
    document: { ...saved.payload, ramPrice: { ...saved.payload.ramPrice, checkedAt: new Date(Date.now() - 7 * 3600000).toISOString() } },
  } });
  const count = async () => Number((await fixture.sql`select count(*) from migration.cms_publish_commands where actor='admin:cron-hero-ram-price' and status='committed'`)[0].count);
  const beforeCount = await count();
  let delayed = false;
  fixture.setRequestHook(async (stage, request) => {
    if (!delayed && stage === 'after' && request.path === '/rest/v1/rpc/roo_apply_cms_publish_command' && request.status === 200) {
      delayed = true;
      await new Promise(resolve => setTimeout(resolve, 21000));
    }
  });
  const signal = AbortSignal.timeout(20000);
  const client = createSupabaseAdminClient({ env, signal });
  const recovered = await refreshRamPrice({ client, env: { ...env, CRON_SECRET: 'fixture-native-timeout-cron' }, signal });
  assert.equal(signal.aborted, true);
  assert.equal(recovered.state, 'updated');
  fixture.setRequestHook(null);
  assert.equal(await count() - beforeCount, 1);
  const [packageAfter] = await fixture.sql`select payload from migration.source_documents where legacy_sanity_id='native-ram-package'`;
  assert.deepEqual(packageAfter, packageBefore);
  const actors = await fixture.sql`select distinct actor from cms.document_revisions where document_id='native-ram-hero'`;
  assert.ok(actors.some(row => row.actor === 'admin:cron-hero-ram-price'));
  Object.assign(result, { passed: true, normalPublish: true, deadlineRecovery: true, deadlineWrites: 1, packageUnchanged: true, actor: 'admin:cron-hero-ram-price' });
} finally {
  if (sourceServer) { sourceServer.closeAllConnections(); await new Promise(resolve => sourceServer.close(resolve)); }
  if (fixture) { await fixture.stop(); await fs.rm(fixture.scratch, { recursive: true, force: true }); }
  restore();
  await fs.mkdir('test-results/ram-price-native', { recursive: true });
  await fs.writeFile('test-results/ram-price-native/report.json', JSON.stringify(result, null, 2));
}
console.log('Native CMS publishes only the RAM quote and recovers a committed deadline.');
