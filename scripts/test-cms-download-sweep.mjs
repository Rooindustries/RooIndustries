const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

for (const key of Object.keys(process.env)) if (/^(SANITY|SUPABASE|REACT_APP_|NEXT_PUBLIC_|RESEND|BLOB_|VERCEL_OIDC|DOWNLOAD_|SITE_URL|FROM_EMAIL|ALLOW_LIVE_)/.test(key)) delete process.env[key];
Object.assign(process.env, { NODE_ENV: 'test', DATA_PRIMARY_BACKEND: 'supabase', CMS_WRITES_PAUSED: 'false', SANITY_STUDIO_CMS_WRITES_PAUSED: 'false', DOWNLOAD_TOKEN_SECRET: 'fixture-download-secret' });
const baseline = process.argv.includes('--baseline');
registerHooks({ load(url, context, nextLoad) {
  const owned = ['src/server/cms/publishCommand.js', 'src/server/cms/sanityAuthorization.js', 'src/server/content/publicContent.js', 'src/server/supabase/assets.js', 'src/server/downloads/downloadToken.js', 'src/server/downloads/downloadStorage.js'];
  const name = owned.find(name => url === new URL(`../${name}`, import.meta.url).href);
  if (name && (baseline || (process.argv.includes('--baseline-coupon') && name === 'src/server/cms/publishCommand.js'))) {
    return { format: 'module', source: execFileSync('git', ['show', `HEAD:${name}`], { encoding: 'utf8' }), shortCircuit: true };
  }
  return nextLoad(url, context);
}, resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const relative = `../${specifier.slice(2)}`;
    for (const suffix of ['', '.js']) { const candidate = new URL(`${relative}${suffix}`, import.meta.url); if (fs.existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context); }
  }
  try { return nextResolve(specifier, context); } catch (error) {
    if (!specifier.startsWith('.') || !context.parentURL?.startsWith('file:')) throw error;
    for (const suffix of ['.js', '/index.js']) {
      const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
      if (fs.existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    throw error;
  }
} });
const only = process.argv.find(value => value.startsWith('--scenario='))?.slice(11).split(',');
const artifact = path.resolve(process.env.ROO_CMS_SWEEP_ARTIFACT || 'test-results/cms-download-sweep.json');
const evidence = { baseline, checkedAt: new Date().toISOString(), productionRequests: 0, scenarios: [], limits: ['Actual isolated PostgreSQL17/PostgREST16.4 and SupabaseDocumentClient, not hosted deployment/RLS/GoTrue.', 'Sanity identity, query, dry-run and assets are synthetic local HTTP; no actual Sanity search/locking engine.', 'Storage service and email delivery are not contacted.'] };
const nativeFetch = globalThis.fetch;
let fixture;
let upstreamOrigin;
let apiServer;
let apiOrigin;
let source = [];
let honorPerspective = false;
let serial = 0;
let proof;
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const check = async (name, fn) => {
  if (only && !only.includes(name)) return;
  proof = {};
  fixture?.setRequestHook(null);
  try { await fn(); evidence.scenarios.push({ name, passed: true, proof }); }
  catch (error) { evidence.scenarios.push({ name, passed: false, error: error.message, code: error.code, stack: error.stack, proof }); }
};
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (!fixture && !upstreamOrigin && url.hostname === testHost && url.pathname === '/') upstreamOrigin = url.origin;
  if (url.origin === upstreamOrigin || url.origin === fixture?.origin || url.origin === apiOrigin) return nativeFetch(input, { ...init, redirect: 'error' });
  throw new Error(`External destination refused before dependency initialization: ${url.origin}`);
};
try {
  const { createSweepPostgresFixture, functionDefinition } = await import('./lib/sweep-postgres-fixture.mjs');
  fixture = await createSweepPostgresFixture();
  await fixture.apply('20260710214023_support_private_file_assets.sql');
  await fixture.apply('20260712092342_close_supabase_port_and_unified_auth.sql', functionDefinition('20260712092342_close_supabase_port_and_unified_auth.sql', 'public.roo_asset_manifest_for_refs'), 'current asset manifest RPC');
  await fixture.apply('20260715120000_add_global_cms_publish_authority.sql');
  await fixture.sql.unsafe("notify pgrst, 'reload schema'");
  await new Promise(resolve => setTimeout(resolve, 200));
  Object.assign(process.env, { SUPABASE_URL: fixture.origin, SUPABASE_SERVICE_ROLE_KEY: fixture.token, NEXT_PUBLIC_SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_ANON_KEY: fixture.token });
  const { sql, client } = fixture;
  fixture.setProviderHandler(async request => {
    const url = new URL(request.path, 'https://fixture.invalid');
    if (url.pathname.endsWith('/users/me')) return { body: { id: 'fixture-editor' } };
    if (url.pathname.includes('/data/query/')) {
      const raw = url.searchParams.get('perspective') === 'raw';
      return { body: { result: honorPerspective && !raw ? source.filter(document => !document._id.startsWith('drafts.')) : source } };
    }
    if (url.pathname.includes('/data/mutate/')) { assert.equal(url.searchParams.get('dryRun'), 'true'); return { body: { transactionId: 'fixture-dry-run', results: [] } }; }
    throw new Error(`Unmapped provider path: ${request.path}`);
  });
  const providerFetch = (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://9g42k3ur.api.sanity.io');
    return globalThis.fetch(`${fixture.origin}/provider${url.pathname}${url.search}`, init);
  };
  const { executeGlobalCmsCommand } = await import('../src/server/cms/publishCommand.js');
  const { verifyGlobalCmsMutation } = await import('../src/server/cms/sanityAuthorization.js');
  const { createSupabaseDocumentClient } = await import('../src/server/supabase/documentClient.js');
  const { fetchPublicContent, clearSupabasePublicContentCache } = await import('../src/server/content/publicContent.js');
  const documents = createSupabaseDocumentClient({ shadowClient: client });
  const commerce = createSupabaseDocumentClient({ shadowClient: client, commerceOnly: true, cutoverGeneration: 0 });
  const row = async id => (await sql`select payload,tombstoned,source_revision from migration.source_documents where legacy_sanity_id=${id}`)[0];
  const synced = async () => {
    await sql`update migration.document_mutation_mirror_outbox set status='applied',applied_at=now() where status<>'applied'`;
    await sql`update migration.commerce_mirror_outbox set status='mirrored',mirrored_at=now() where status<>'mirrored'`;
  };
  const seed = async (type = 'hero') => {
    const id = `cms.fixture.${++serial}`;
    const document = { _id: id, _type: type, headingLine1: 'initial', title: 'Synthetic', price: 99 };
    if (type === 'package') { source = [{ ...document, _id: `drafts.${id}`, _rev: `seed-${serial}` }]; await command(body(document, `seed-${serial}`)); }
    else await documents.create(document);
    await synced();
    return document;
  };
  const body = (document, revision, operation = 'publish') => ({ projectId: '9g42k3ur', dataset: 'production', operation, type: document._type, documentId: document._id, sourceRevision: revision, ...(operation === 'publish' ? { document } : {}), assetManifest: [] });
  const command = (request, overrides = {}) => executeGlobalCmsCommand({ body: request, authorization: 'Bearer fixture-editor-token', supabaseClient: client, env: process.env, fetchImpl: providerFetch, ...overrides });
  const sourceDocument = (document, revision, draft = true) => ({ ...document, _id: `${draft ? 'drafts.' : ''}${document._id}`, _rev: revision });

  for (const type of ['hero', 'package']) for (const operation of ['publish', 'unpublish', 'delete']) await check(`authority-order-${type}-${operation}`, async () => {
    const original = await seed(type);
    const r1 = { ...original, headingLine1: 'r1' };
    const r2 = { ...original, headingLine1: 'r2' };
    const entered = defer(); const release = defer();
    const order = [];
    let activeB = false;
    fixture.setRequestHook(async (phase, request) => { if (phase === 'after' && request.path.includes('/rpc/roo_fetch_shadow_documents') && request.body?.p_ids?.includes(original._id)) order.push(`${activeB ? 'B' : 'A'} authority read`); });
    source = [sourceDocument(r1, 'r1', operation === 'publish')];
    const verifyMutation = async options => { await verifyGlobalCmsMutation(options); order.push('A verified Sanity r1'); if (operation !== 'publish') { entered.resolve(); await release.promise; } };
    const prepareAssets = async () => { order.push('A asset preparation paused'); entered.resolve(); await release.promise; return []; };
    const a = command(body(r1, 'r1', operation), { verifyMutation, prepareAssets }).then(result => ({ result }), error => ({ error: { code: error.code, status: error.status } }));
    await Promise.race([entered.promise, a.then(value => { throw new Error(`A failed before ordering gate: ${JSON.stringify(value)}`); })]);
    source = [sourceDocument(r2, 'r2')];
    activeB = true;
    const b = await command(body(r2, 'r2'));
    order.push('B committed r2 in Supabase');
    activeB = false;
    release.resolve();
    const result = await a;
    order.push('A resumed authority mutation');
    const saved = await row(original._id);
    proof = { order, a: result, bSyncPending: b.syncPending, saved: saved ? { headingLine1: saved.payload.headingLine1, tombstoned: saved.tombstoned, revision: saved.source_revision } : null, requests: fixture.requestLog.slice(-15) };
    assert.equal(saved?.payload.headingLine1, 'r2'); assert.equal(saved.tombstoned, false); assert.equal(result.error?.status, 409);
  });
  for (const type of ['hero', 'package']) for (const operation of ['publish', 'unpublish', 'delete']) await check(`pending-mirror-${type}-${operation}`, async () => {
    const original = await seed(type);
    const r2 = { ...original, headingLine1: 'r2' };
    source = [sourceDocument(r2, 'r2')];
    await command(body(r2, 'r2'));
    source = [sourceDocument({ ...original, headingLine1: 'r1' }, 'r1', operation === 'publish')];
    let result; try { result = await command(body({ ...original, headingLine1: 'r1' }, 'r1', operation)); } catch (error) { result = { error: error.code, status: error.status }; }
    const saved = await row(original._id);
    proof = { result, saved: saved ? { headingLine1: saved.payload.headingLine1, tombstoned: saved.tombstoned } : null };
    assert.equal(saved?.payload.headingLine1, 'r2'); assert.equal(saved.tombstoned, false); assert.equal(result.status, 409);
  });
  await check('draft-default-perspective', async () => {
    const original = await seed(); source = [sourceDocument(original, 'draft-r1')]; honorPerspective = true;
    try { const result = await command(body(original, 'draft-r1')); proof = { result, requests: fixture.requestLog.slice(-8) }; assert.equal(result.committed, true); }
    finally { honorPerspective = false; }
  });
  await check('receipt-replay-pending-mirror', async () => {
    const original = await seed(); source = [sourceDocument(original, 'replay-r1')];
    const request = body(original, 'replay-r1'); const first = await command(request); const revision = (await row(original._id)).source_revision;
    source = []; const replay = await command(request); proof = { first, replay };
    assert.equal(replay.replayed, true); assert.equal((await row(original._id)).source_revision, revision);
  });
  for (const rejection of [false, true]) await check(rejection ? 'old-rejected-fetch-new-generation' : 'old-content-fetch-publish-clear-resolve', async () => {
    await sql`delete from cms.documents where document_type='hero'`;
    await sql`delete from migration.source_documents where document_type='hero'`;
    clearSupabasePublicContentCache();
    const original = await seed(); const next = { ...original, headingLine1: 'new-committed' };
    const entered = defer(); const release = defer(); let held = false; let reads = 0;
    fixture.setRequestHook(async (phase, request) => {
      if (phase === 'after' && request.path.includes('/rpc/roo_fetch_shadow_documents') && request.body?.p_document_types?.includes('hero')) {
        reads++;
        if (!held) { held = true; entered.resolve(); await release.promise; if (rejection) throw new Error('synthetic old fetch failure'); }
      }
    });
    const read = () => fetchPublicContent({ resource: 'hero', searchParams: new URLSearchParams(), backend: 'supabase' });
    const old = read().then(data => ({ data }), error => ({ error: error.code || error.message }));
    await entered.promise;
    source = [sourceDocument(next, 'cache-r2')];
    await command(body(next, 'cache-r2'));
    let fresh;
    if (rejection) fresh = await read();
    release.resolve(); const oldResult = await old;
    const reader = await read(); const beforeAgain = reads; const repeated = await read();
    proof = { oldResult, fresh, reader, repeated, reads, repeatedReadRequests: reads - beforeAgain };
    assert.equal(reader.headingLine1, 'new-committed'); assert.equal(repeated.headingLine1, 'new-committed'); assert.equal(reads, 3); assert.equal(reads - beforeAgain, 0);
  });

  await check('old-asset-manifest-publish-clear-resolve', async () => {
    const { enrichSupabaseContentAssets, clearSupabaseAssetManifestCache } = await import('../src/server/supabase/assets.js');
    clearSupabaseAssetManifestCache();
    const original = await seed(); const assetId = `image-synthetic-${++serial}`;
    const oldAsset = { legacy_sanity_asset_id: assetId, source_url: `https://cdn.sanity.io/images/9g42k3ur/production/${serial}.png`, storage_bucket: 'site-content-public', storage_path: `images/old-${serial}.png`, mime_type: 'image/png', byte_size: 5, sha256: 'a'.repeat(64) };
    assert.equal((await client.rpc('roo_upsert_asset', { p_asset: oldAsset })).error, null);
    const entered = defer(); const release = defer(); let held = false; let reads = 0;
    fixture.setRequestHook(async (phase, request) => { if (phase === 'after' && request.path.includes('/roo_asset_manifest_for_refs')) { reads++; if (!held) { held = true; entered.resolve(); await release.promise; } } });
    const read = () => enrichSupabaseContentAssets({ data: { image: { asset: { _ref: assetId } } }, client });
    const old = read(); await entered.promise;
    const nextAsset = { ...oldAsset, storage_path: `images/new-${serial}.png` };
    const nextDocument = { ...original, image: { asset: { _ref: assetId } } }; source = [sourceDocument(nextDocument, 'manifest-r2')];
    await command(body(nextDocument, 'manifest-r2'), { prepareAssets: async () => [nextAsset] });
    const fresh = await read(); release.resolve(); const obsolete = await old; const reader = await read();
    proof = { fresh, obsolete, reader, reads, boundary: 'Native manifest upsert + actual CMS commit; asset upload preparation supplied only for cache migration ordering.' };
    assert.equal(reader.image.asset._supabaseUrl, fresh.image.asset._supabaseUrl); assert.match(reader.image.asset._supabaseUrl, /\/images\/new-/); assert.equal(reads, 2);
  });

  await check('coupon-publish-preserves-current-operational-fields', async () => {
    const id = `cms.coupon.${++serial}`;
    const initial = { _id: id, _type: 'coupon', title: 'Synthetic coupon', code: `fixture-${serial}`, discountType: 'percent', discountPercent: 10, isActive: false, timesUsed: 5, activeReservations: 2, redemptionCount: 5, autoDeactivatedByRedemptionId: 'synthetic-redemption', autoDeactivatedAt: '2026-10-01T00:00:00Z' };
    await commerce.create(initial); await synced();
    const draft = { ...initial, title: 'New editor title', timesUsed: 0, activeReservations: 0, redemptionCount: 0, autoDeactivatedByRedemptionId: 'old-redemption', autoDeactivatedAt: '2026-09-01T00:00:00Z' };
    source = [sourceDocument(draft, 'coupon-r1')]; await command(body(draft, 'coupon-r1'));
    const saved = await row(id); const [typed] = await sql`select consumed_uses,reserved_uses,active,discount_basis_points,payload from commerce.coupons where legacy_sanity_id=${id}`; proof = { saved: saved.payload, typed };
    for (const field of ['timesUsed', 'activeReservations', 'redemptionCount', 'autoDeactivatedByRedemptionId', 'autoDeactivatedAt']) assert.equal(saved.payload[field], initial[field]);
    assert.equal(saved.payload.title, 'New editor title'); assert.equal(saved.payload.discountPercent, 10);
    assert.equal(typed.consumed_uses, 5); assert.equal(typed.reserved_uses, 2); assert.equal(typed.active, false); assert.equal(typed.discount_basis_points, 1000);
  });
  for (const type of ['hero', 'package']) await check(`malformed-mirror-status-${type}-replay`, async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const original = await seed(type); source = [sourceDocument(original, 'mirror-r1')]; const request = body(original, 'mirror-r1'); const first = await command(request);
    let nativeStatus;
    const transport = createClient(fixture.origin, fixture.token, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (String(input).includes('_mirror_status_for_ids')) { nativeStatus = await response.clone().json(); return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }); }
      return response;
    } } });
    const revision = (await row(original._id)).source_revision;
    const replay = await command(request, { supabaseClient: transport });
    proof = { first, nativeStatus, replay, successfulMalformedHttpResponse: null }; assert.equal(nativeStatus.pending, 1); assert.equal(replay.replayed, true); assert.equal(replay.syncPending, true); assert.equal((await row(original._id)).source_revision, revision);
  });

  const { verifyDownloadToken, createDownloadToken, hashDownloadEmail } = await import('../src/server/downloads/downloadToken.js');
  const { streamLocalDownload, isLocalDownloadAvailable } = await import('../src/server/downloads/downloadStorage.js');
  const signed = payload => { const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${encoded}.${crypto.createHmac('sha256', process.env.DOWNLOAD_TOKEN_SECRET).update(encoded).digest('base64url')}`; };
  await check('download-token-invalid-time', async () => {
    const invalid = ['not-a-time', null, {}, 'Infinity', -1];
    const results = invalid.map(exp => ({ exp, result: verifyDownloadToken({ token: signed({ purpose: 'download-file', slug: 'synthetic', fileName: 'synthetic.zip', bookingId: 'booking.fixture', emailHash: hashDownloadEmail('fixture@example.invalid'), iat: 1, exp }) }) }));
    proof = { results }; assert.ok(results.every(item => !item.result.ok));
    const token = createDownloadToken({ slug: 'synthetic', fileName: 'synthetic.zip', bookingId: 'booking.fixture', email: 'fixture@example.invalid' }); assert.equal(verifyDownloadToken({ token }).ok, true);
  });
  await check('download-token-email-hash-type', async () => {
    const now = Math.floor(Date.now() / 1000); const payload = { purpose: 'download-file', slug: 'synthetic', fileName: 'synthetic.zip', bookingId: 'booking.fixture', emailHash: [hashDownloadEmail('fixture@example.invalid')], iat: now, exp: now + 60 };
    const result = verifyDownloadToken({ token: signed(payload) }); proof = { payload, result }; assert.equal(result.ok, false);
  });
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'roo-cms-download-local-'));
  const root = path.join(files, 'downloads'); fs.mkdirSync(root);
  const env = { ...process.env, DOWNLOAD_ROOT_DIR: root, DOWNLOAD_STORAGE_BACKEND: 'local' };
  const download = { slug: 'synthetic', fileName: 'synthetic.zip', contentType: 'application/zip' };
  await check('local-download-symlink-root-escape', async () => {
    const outside = path.join(files, 'outside-owned-synthetic.zip'); fs.writeFileSync(outside, 'outside-owned-synthetic-secret'); fs.symlinkSync(outside, path.join(root, download.fileName));
    let result; try { const opened = await streamLocalDownload(download, env); result = { bytes: await new Response(opened.stream).text() }; } catch (error) { result = { code: error.code }; }
    proof = { result, available: await isLocalDownloadAvailable(download, env) }; assert.ok(result.code); assert.equal(proof.available, false);
  });
  await check('local-download-configured-integrity', async () => {
    const fileName = 'pinned.zip'; const original = Buffer.from('original-synthetic-bytes'); fs.writeFileSync(path.join(root, fileName), Buffer.from('modified-synthetic-bytes'));
    const pinned = { ...download, fileName, sizeBytes: original.length, sha256: crypto.createHash('sha256').update(original).digest('hex') };
    let result; try { const opened = await streamLocalDownload(pinned, env); result = { bytes: await new Response(opened.stream).text() }; } catch (error) { result = { code: error.code }; }
    proof = { result }; assert.ok(result.code);
    fs.writeFileSync(path.join(root, fileName), original); const opened = await streamLocalDownload(pinned, env); assert.equal(await new Response(opened.stream).text(), original.toString());
  });
  await check('native-booking-download-ownership-eligibility-revocation', async () => {
    const { validateDownloadAccess } = await import('../src/server/downloads/downloadAccess.js');
    const { GET } = await import('../app/api/downloads/file/route.js');
    const fileName = 'eligible.zip'; const bytes = Buffer.from('eligible-owned-synthetic-bytes'); fs.writeFileSync(path.join(root, fileName), bytes);
    const entry = { slug: 'eligible', fileName, blobPath: 'downloads/eligible.zip', storageBackend: 'local', sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), blobEtag: 'fixture-local-etag', allowedPackageTitles: ['Vertex'] };
    Object.assign(process.env, { DOWNLOAD_ROOT_DIR: root, DOWNLOAD_STORAGE_BACKEND: 'local', DOWNLOAD_CATALOG_JSON: JSON.stringify([entry]) });
    const booking = await documents.create({ _id: `booking.cms.${++serial}`, _type: 'booking', status: 'captured', email: 'fixture@example.invalid', payerEmail: 'payer@example.invalid', packageTitle: 'Vertex', orderId: `ORDER-FIXTURE-${serial}` });
    apiServer = http.createServer(async (req, res) => {
      try { const response = await GET(new Request(`${apiOrigin}${req.url}`, { headers: req.headers })); res.writeHead(response.status, Object.fromEntries(response.headers)); if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end(); }
      catch (error) { res.writeHead(500); res.end(error.message); }
    });
    apiServer.listen(0, testHost); await once(apiServer, 'listening'); apiOrigin = `http://${testHost}:${apiServer.address().port}`;
    const wrong = await validateDownloadAccess({ slug: 'eligible', orderId: booking._id, email: 'other@example.invalid', client: documents }); assert.equal(wrong.status, 404);
    const valid = await validateDownloadAccess({ slug: 'eligible', orderId: booking.orderId, email: 'payer@example.invalid', client: documents }); assert.equal(valid.status, 200);
    const get = () => globalThis.fetch(`${apiOrigin}/api/downloads/file`, { headers: { cookie: `download_access=${valid.downloadToken}` } });
    const good = await get(); const body = await good.text(); assert.equal(good.status, 200); assert.equal(body, bytes.toString()); assert.equal(good.headers.get('cache-control'), 'private, no-store');
    await documents.patch(booking._id).set({ status: 'refunded' }).commit(); const refunded = await get(); assert.equal(refunded.status, 400); await refunded.text();
    await documents.patch(booking._id).set({ status: 'captured', email: 'changed@example.invalid', payerEmail: '' }).commit(); const moved = await get(); assert.equal(moved.status, 403); await moved.text();
    await documents.patch(booking._id).set({ email: 'fixture@example.invalid', payerEmail: 'payer@example.invalid', packageTitle: 'Ineligible' }).commit(); const ineligible = await get(); assert.equal(ineligible.status, 403); await ineligible.text();
    await documents.delete(booking._id); const deleted = await get(); assert.equal(deleted.status, 404); await deleted.text();
    proof = { wrongEmail: wrong.status, granted: valid.status, served: good.status, bytes: body.length, refunded: refunded.status, changedEmail: moved.status, ineligible: ineligible.status, deleted: deleted.status, boundary: 'Actual route handler over owned HTTP, actual booking adapter/PostgREST/SQL; Next router/cookie transport is not hosted.' };
  });
  evidence.ok = evidence.scenarios.length > 0 && evidence.scenarios.every(item => item.passed);
} catch (error) { evidence.ok = false; evidence.failure = { message: error.message, stack: error.stack }; }
finally {
  globalThis.fetch = nativeFetch;
  if (apiServer) { apiServer.closeAllConnections(); await new Promise(resolve => apiServer.close(resolve)); }
  if (fixture) { fixture.setRequestHook(null); evidence.runtime = { postgres: fixture.postgresVersion, postgrest: fixture.postgrestVersion, scratch: fixture.scratch }; evidence.migrations = fixture.manifest; await fixture.stop(); evidence.servicesStopped = true; }
  fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: evidence.ok, scenarios: evidence.scenarios.map(({ name, passed, error }) => ({ name, passed, error })), failure: evidence.failure, artifact })}\n`);
}
if (!evidence.ok) process.exitCode = 1;
