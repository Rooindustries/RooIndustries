const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';

for (const key of Object.keys(process.env)) if (/^(SANITY|SUPABASE|REACT_APP_|NEXT_PUBLIC_|RESEND|BLOB_|VERCEL_OIDC|DOWNLOAD_|SITE_URL|FROM_EMAIL|ALLOW_LIVE_)/.test(key)) delete process.env[key];
Object.assign(process.env, { NODE_ENV: 'test', DATA_PRIMARY_BACKEND: 'supabase' });
const baseline = process.argv.includes('--baseline');
const only = process.argv.find(value => value.startsWith('--scenario='))?.slice(11).split(',');
const artifact = path.resolve(process.env.ROO_CMS_SWEEP_ARTIFACT || `test-results/cms-download-http-${baseline ? 'before' : 'after'}.json`);
const root = path.resolve(new URL('..', import.meta.url).pathname);
const evidence = { baseline, checkedAt: new Date().toISOString(), productionRequests: 0, scenarios: [], limits: ['Actual Sanity/Supabase Storage/Resend SDKs and synthetic local provider HTTP only, no actual provider engine.', 'Studio cleanup helper executes from its exact source function; Studio UI is not mounted.', 'No email lifecycle/lease/account mutations checked or changed by rendering checks.'] };
const readSource = name => baseline ? execFileSync('git', ['show', `HEAD:${name}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, name), 'utf8');
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (!specifier.startsWith('.') || !context.parentURL?.startsWith('file:')) throw error;
    for (const suffix of ['.js', '/index.js']) { const candidate = new URL(`${specifier}${suffix}`, context.parentURL); if (fs.existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context); }
    throw error;
  }
}, load(url, context, nextLoad) {
  const owned = ['src/server/cms/sanityAuthorization.js', 'src/server/cms/assets.js', 'src/server/downloads/downloadStorage.js', 'src/server/email/referralResetEmail.js', 'src/server/email/referralVerificationEmail.js', 'src/server/api/ref/referralEmailDispatches.js'];
  const name = owned.find(name => url === new URL(name, `file://${root}/`).href);
  if (baseline && name) return { format: 'module', source: readSource(name), shortCircuit: true };
  return nextLoad(url, context);
} });
const fifoProbe = process.argv.find(value => value.startsWith('--fifo-probe='))?.slice(13);
if (fifoProbe) {
  globalThis.fetch = () => { throw new Error('Network forbidden in FIFO probe'); };
  const { streamLocalDownload } = await import('../src/server/downloads/downloadStorage.js');
  try { await streamLocalDownload({ fileName: 'fifo.zip' }, { DOWNLOAD_ROOT_DIR: fifoProbe }); process.exit(2); }
  catch (error) { process.stdout.write(`${JSON.stringify({ refused: true, code: error.code, guard: Object.fromEntries(['NODE_OPTIONS', 'ROO_TEST_HOST', 'TOOLING_NETWORK_GUARD', 'BASE_URL'].map(name => [name, process.env[name] ?? null])) })}\n`); process.exit(0); }
}
const nativeFetch = globalThis.fetch;
let origin; let otherOrigin; let server; let otherServer;
let mode = ''; let requests = []; let secondRequests = 0; let stored = Buffer.alloc(0); let draft;
const bytes = Buffer.from('owned-synthetic-png');
const asset = { _id: 'image-fixture', _type: 'sanity.imageAsset', assetId: 'fixture', extension: 'png', url: 'https://cdn.sanity.io/images/9g42k3ur/production/fixture.png', mimeType: 'image/png', size: bytes.length, sha1hash: crypto.createHash('sha1').update(bytes).digest('hex') };
const document = { _id: 'cms.http.fixture', _type: 'hero', image: { asset: { _ref: asset._id } } };
const result = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const check = async (name, fn) => { if (only && !only.includes(name)) return; requests = []; secondRequests = 0; try { const proof = await fn(); evidence.scenarios.push({ name, passed: true, proof, requests }); } catch (error) { evidence.scenarios.push({ name, passed: false, error: error.message, proof: error.proof, requests }); } };
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if ([origin, otherOrigin].includes(url.origin)) return nativeFetch(input, { ...init, redirect: init?.redirect || 'error' });
  if (url.origin === 'https://storage.fixture.invalid') return nativeFetch(`${origin}${url.pathname}${url.search}`, { ...init, redirect: 'error' });
  throw new Error(`External target refused before initialization: ${url.origin}`);
};
try {
  otherServer = http.createServer((req, res) => { secondRequests++; result(res, 200, { id: 'unexpected-provider' }); });
  otherServer.listen(0, testHost); await once(otherServer, 'listening'); otherOrigin = `http://${testHost}:${otherServer.address().port}`;
  server = http.createServer(async (req, res) => {
    try {
      const parts = []; for await (const part of req) parts.push(part); const body = Buffer.concat(parts);
      const url = new URL(req.url, origin); requests.push({ method: req.method, path: req.url, contentType: req.headers['content-type'], bytes: body.length });
      if (url.pathname.includes('/users/me')) {
        if (mode === 'authorization-redirect') { res.writeHead(302, { location: `${otherOrigin}/redirect-target` }); res.end(); return; }
        result(res, 200, { id: 'fixture-editor' }); return;
      }
      if (url.pathname.includes('/data/query/')) { result(res, 200, { result: mode === 'asset-port' || mode === 'assets' || mode === 'asset-corrupt' ? [{ ...asset, ...(mode === 'asset-port' ? { url: asset.url.replace('cdn.sanity.io/', 'cdn.sanity.io:8443/') } : {}) }] : [{ _id: 'drafts.cms.http.fixture', _type: 'hero', _rev: 'r1' }] }); return; }
      if (url.pathname.includes('/data/mutate/')) {
        const command = JSON.parse(body.toString()); requests.at(-1).mutations = command.mutations;
        const patch = command.mutations.find(item => item.patch)?.patch;
        if (Object.keys(patch?.set || {}).some(key => key.startsWith('_'))) { result(res, 400, { error: { type: 'mutationError', description: 'Reserved field name in cleanup patch' } }); return; }
        if (patch?.ifRevisionID && patch.ifRevisionID !== draft?._rev) { result(res, 409, { error: { type: 'mutationError', description: 'Document revision conflict' } }); return; }
        const deletion = command.mutations.find(item => item.delete)?.delete;
        if (deletion) draft = null;
        result(res, 200, { transactionId: 'fixture-transaction', results: [{ id: 'drafts.cms.http.fixture', operation: 'delete' }] }); return;
      }
      if (url.pathname.startsWith('/cdn/')) { res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length }); res.end(mode === 'asset-corrupt' ? Buffer.from('different-png-bytes') : bytes); return; }
      if (url.pathname.startsWith('/storage/v1/bucket/')) { result(res, 200, { id: mode === 'storage-wrong-bucket-id' ? 'other-bucket' : 'optimization-builds-private', name: 'optimization-builds-private', public: mode === 'storage-public' }); return; }
      if (url.pathname.startsWith('/storage/v1/object/info/')) { result(res, 200, { id: 'fixture-object', version: 'fixture-version', name: mode === 'storage-wrong-name' ? 'downloads/other.zip' : 'downloads/eligible.zip', ...(mode === 'storage-missing-bucket-id' ? {} : { bucket_id: mode === 'storage-null-bucket-id' ? null : mode === 'storage-wrong-bucket' ? 'other-bucket' : 'optimization-builds-private' }), size: mode === 'storage-wrong-size' ? bytes.length + 1 : bytes.length, etag: mode === 'storage-wrong-etag' ? 'changed-etag' : 'fixture-etag', content_type: mode === 'storage-wrong-type' ? 'text/html' : 'application/zip', created_at: '2026-10-01T00:00:00Z' }); return; }
      if (url.pathname.startsWith('/storage/v1/object/sign/')) { result(res, 200, { signedURL: '/object/sign/optimization-builds-private/downloads/eligible.zip?token=fixture-signed-token' }); return; }
      if (url.pathname.startsWith('/storage/v1/object/') && req.method === 'POST') { stored = body; result(res, 200, { Key: 'site-content-public/images/fixture.png', Id: 'fixture-object' }); return; }
      if (url.pathname.startsWith('/storage/v1/object/') && req.method === 'GET') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': stored.length }); res.end(stored); return; }
      if (url.pathname === '/emails') { const message = JSON.parse(body.toString()); requests.at(-1).message = message; result(res, 200, { id: 'fixture-email' }); return; }
      throw new Error(`Unmapped local provider endpoint: ${req.method} ${req.url}`);
    } catch (error) { result(res, 500, { error: error.message }); }
  });
  server.listen(0, testHost); await once(server, 'listening'); origin = `http://${testHost}:${server.address().port}`;
  Object.assign(process.env, { SUPABASE_URL: 'https://storage.fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-storage-key', NEXT_PUBLIC_BASE_URL: 'https://site.fixture.invalid' });
  const { createClient: createSanityClient } = await import('@sanity/client');
  const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');
  const { Resend } = await import('resend');
  const sanity = createSanityClient({ apiHost: origin, useProjectHostname: false, projectId: '9g42k3ur', dataset: 'production', apiVersion: '2026-07-01', token: 'fixture-editor', useCdn: false, perspective: 'raw', maxRetries: 0 });
  const storage = createSupabaseClient('https://storage.fixture.invalid', 'fixture-storage-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const sourceFetch = async (input, init) => { const url = new URL(input); assert.ok(url.origin === 'https://9g42k3ur.api.sanity.io' || url.hostname === 'cdn.sanity.io'); if (url.hostname === 'cdn.sanity.io') { requests.push({ logicalOrigin: url.origin }); return nativeFetch(`${origin}/cdn${url.pathname}`, { ...init, redirect: init?.redirect || 'error' }); } return nativeFetch(`${origin}${url.pathname}${url.search}`, { ...init }); };
  const { identifyGlobalCmsUser } = await import('../src/server/cms/sanityAuthorization.js');
  const { prepareGlobalCmsAssets } = await import('../src/server/cms/assets.js');
  const { sendReferralEmailDirect } = await import('../src/server/api/ref/referralEmailDispatches.js');
  const { streamLocalDownload, createSignedSupabaseDownloadUrl } = await import('../src/server/downloads/downloadStorage.js');
  await check('local-download-fifo-refusal', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roo-cms-fifo-')); execFileSync('mkfifo', [path.join(directory, 'fifo.zip')]);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--fifo-probe=${directory}`, ...(baseline ? ['--baseline'] : [])], { env: { PATH: process.env.PATH, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    const started = Date.now(); let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 1500);
    const [status, signal] = await once(child, 'exit'); clearTimeout(timer);
    const proof = { status, signal, timedOut, elapsedMs: Date.now() - started, output }; assert.equal(timedOut, false, JSON.stringify(proof)); assert.equal(status, 0);
    const childGuard = JSON.parse(output).guard; assert.ok(childGuard.NODE_OPTIONS?.includes('--import')); assert.equal(childGuard.ROO_TEST_HOST, testHost);
    for (const name of ['BASE_URL', 'TOOLING_NETWORK_GUARD']) if (process.env[name] !== undefined) assert.equal(childGuard[name], process.env[name]);
    proof.inheritedGuard = childGuard; return proof;
  });
  await check('local-download-parent-symlink-after-realpath', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roo-cms-parent-race-')); const root = path.join(directory, 'root'); const outside = path.join(directory, 'outside'); fs.mkdirSync(root); fs.mkdirSync(outside); fs.writeFileSync(path.join(root, 'eligible.zip'), 'inside'); fs.writeFileSync(path.join(outside, 'eligible.zip'), 'outside-owned-synthetic');
    const open = fsp.open; let raced = false; let outcome;
    fsp.open = async (filePath, ...args) => { if (!raced && filePath === path.join(root, 'eligible.zip')) { raced = true; fs.renameSync(root, `${root}-before`); fs.symlinkSync(outside, root); } return open(filePath, ...args); };
    try { const result = await streamLocalDownload({ fileName: 'eligible.zip' }, { DOWNLOAD_ROOT_DIR: root }); outcome = { bytes: await new Response(result.stream).text() }; } catch (error) { outcome = { code: error.code }; }
    finally { fsp.open = open; }
    const proof = { raced, outcome }; assert.equal(raced, true); assert.ok(outcome.code, JSON.stringify(proof)); return proof;
  });
  await check('authorization-refuses-cross-origin-redirect', async () => {
    mode = 'authorization-redirect'; let outcome; try { outcome = await identifyGlobalCmsUser({ authorization: 'Bearer fixture-editor', fetchImpl: sourceFetch }); } catch (error) { outcome = { code: error.code, status: error.status }; }
    const proof = { outcome, secondRequests }; assert.equal(secondRequests, 0, JSON.stringify(proof)); assert.equal(outcome.code, 'CMS_AUTH_UNAVAILABLE'); return proof;
  });
  const studioSource = readSource('rooindustries/actions/supabaseAuthorityActions.jsx');
  const start = studioSource.indexOf('const deleteDraftAtRevision ='); const end = studioSource.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start); const cleanup = vm.runInNewContext(`${studioSource.slice(start, end)}; deleteDraftAtRevision`);
  await check('draft-cleanup-query-r1-actual-r2', async () => {
    mode = 'draft-delete'; draft = { _id: 'drafts.cms.http.fixture', _type: 'hero', _rev: 'r2' };
    let outcome; try { outcome = await cleanup({ client: sanity, draftId: draft._id, revision: 'r1', document: { _id: 'drafts.cms.http.fixture', _type: 'hero', title: 'Fixture draft content' } }); } catch (error) { outcome = { status: error.statusCode }; }
    const proof = { outcome, remainingDraft: draft }; assert.equal(draft?._rev, 'r2', JSON.stringify(proof)); return proof;
  });
  await check('draft-cleanup-current-r1', async () => { mode = 'draft-delete'; draft = { _id: 'drafts.cms.http.fixture', _type: 'hero', _rev: 'r1' }; assert.equal(await cleanup({ client: sanity, draftId: draft._id, revision: 'r1', document: { _id: 'drafts.cms.http.fixture', _type: 'hero', title: 'Fixture draft content' } }), true); assert.equal(draft, null); return { removed: true }; });
  for (const assetMode of ['assets', 'asset-corrupt', 'asset-port']) await check(`asset-prepare-${assetMode}`, async () => {
    mode = assetMode; stored = Buffer.alloc(0);
    const manifest = [{ ...asset, ...(mode === 'asset-port' ? { url: asset.url.replace('cdn.sanity.io/', 'cdn.sanity.io:8443/') } : {}) }];
    const client = { storage: storage.storage, rpc: async () => ({ data: [], error: null }) };
    let outcome; try { outcome = await prepareGlobalCmsAssets({ document, suppliedManifest: manifest, token: 'fixture-editor', supabaseClient: client, fetchImpl: sourceFetch, sanityClientFactory: () => sanity }); } catch (error) { outcome = { code: error.code, status: error.status }; }
    const proof = { outcome, storedBytes: stored.length };
    if (assetMode === 'assets') { assert.equal(outcome[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex')); assert.deepEqual(stored, bytes); }
    else { assert.ok(outcome.code, JSON.stringify(proof)); assert.equal(stored.length, 0); if (assetMode === 'asset-port') assert.equal(requests.filter(request => request.logicalOrigin).length, 0); }
    return proof;
  });
  for (const state of ['valid', 'missing-bucket-id', 'null-bucket-id', 'wrong-name', 'wrong-bucket', 'wrong-bucket-id', 'public', 'wrong-size', 'wrong-etag', 'wrong-type']) await check(`storage-sdk-${state}`, async () => {
    mode = `storage-${state}`;
    const download = { fileName: 'eligible.zip', blobPath: 'downloads/eligible.zip', storageBucket: 'optimization-builds-private', sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), blobEtag: 'fixture-etag', contentType: 'application/zip' };
    let outcome; try { outcome = await createSignedSupabaseDownloadUrl(download, { env: process.env, client: storage }); } catch (error) { outcome = { code: error.code, message: error.message }; }
    const signedRequests = requests.filter(request => request.path?.startsWith('/storage/v1/object/sign/')).length;
    const proof = { outcome, signedRequests, boundary: 'Actual Supabase Storage SDK camel-case transformation and local HTTP; hosted Storage not verified.' };
    if (['valid', 'missing-bucket-id', 'null-bucket-id'].includes(state)) { assert.equal(signedRequests, 1); assert.equal(new URL(outcome).searchParams.get('download'), download.fileName); }
    else { assert.equal(signedRequests, 0, JSON.stringify(proof)); assert.ok(outcome.code); }
    return proof;
  });
  await check('booking-html-escaped-fields-valid-targets', async () => {
    mode = 'email'; const source = fs.readFileSync(path.join(root, 'src/server/api/ref/bookingEmails.js'), 'utf8'); const start = source.indexOf('const escapeHtml ='); const end = source.indexOf('const resolveLogoUrl =', start);
    const render = vm.runInNewContext(`${source.slice(start, end)}; emailHtml`);
    const html = render({ logoUrl: 'https://cdn.fixture.invalid/logo.png', siteName: 'Roo Industries', heading: '<script>alert(1)</script>', intro: 'A & B', discordInviteUrl: 'https://discord.com/invite/qs5HKNyazD', discordLabel: 'Join <now>', fields: [{ label: '<img>', value: '<a href="https://other.invalid">bad</a>' }] });
    await new Resend('fixture-resend', { baseUrl: origin }).emails.send({ from: 'fixture@example.invalid', to: ['owner@example.invalid'], subject: 'Synthetic rendering proof', html });
    const delivered = requests.find(request => request.message).message.html; assert.ok(!delivered.includes('<script>')); assert.ok(!delivered.includes('<img>')); assert.ok(delivered.includes('&lt;script&gt;')); assert.ok(delivered.includes('href="https://discord.com/invite/qs5HKNyazD"')); assert.ok(delivered.includes('src="https://cdn.fixture.invalid/logo.png"')); return { escaped: true, correctDiscordTarget: true, correctLogoTarget: true, boundary: 'Exact existing HTML helper + actual Resend SDK/local HTTP; no booking lifecycle/send decision invoked.' };
  });
  for (const dispatchKind of ['registration_verification', 'password_reset']) await check(`email-opaque-fragment-${dispatchKind}`, async () => {
    mode = 'email'; const token = 'opaque&next=unexpected#tail';
    const result = await sendReferralEmailDirect({ dispatchKind, referralId: 'referral.fixture', recipientEmail: 'fixture@example.invalid', token, name: '<img src=x onerror=alert(1)>', resendClient: new Resend('fixture-resend-key', { baseUrl: origin }), env: process.env });
    const message = requests.find(request => request.message).message;
    const href = message.html.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'); const url = new URL(href); const parsedToken = new URLSearchParams(url.hash.slice(1)).get('token');
    const proof = { result, href, parsedToken, recipient: message.to, escapedName: !message.html.includes('<img src=x') };
    assert.equal(parsedToken, token, JSON.stringify(proof)); assert.equal(url.origin, 'https://site.fixture.invalid'); assert.equal(proof.escapedName, true); assert.deepEqual(message.to, ['fixture@example.invalid']); return proof;
  });
  await check('email-invalid-base-targets-refused', async () => {
    mode = 'email'; const results = [];
    for (const baseUrl of ['https://site.fixture.invalid/landing?x=1#section', 'javascript:alert(1)', 'https://credential@site.fixture.invalid']) {
      let outcome; try { outcome = await sendReferralEmailDirect({ dispatchKind: 'registration_verification', referralId: 'referral.fixture', recipientEmail: 'fixture@example.invalid', token: 'fixture-token', resendClient: new Resend('fixture-resend', { baseUrl: origin }), env: { ...process.env, NEXT_PUBLIC_BASE_URL: baseUrl } }); } catch (error) { outcome = { error: error.message }; }
      results.push({ baseUrl, outcome });
    }
    const sent = requests.filter(request => request.message).length; const proof = { results, sent }; assert.equal(sent, 0, JSON.stringify(proof)); assert.ok(results.every(result => result.outcome.error)); return proof;
  });
  await check('email-valid-base-path-prefix', async () => {
    mode = 'email'; await sendReferralEmailDirect({ dispatchKind: 'password_reset', referralId: 'referral.fixture', recipientEmail: 'fixture@example.invalid', token: 'fixture-token', resendClient: new Resend('fixture-resend', { baseUrl: origin }), env: { ...process.env, NEXT_PUBLIC_BASE_URL: 'https://site.fixture.invalid/prefix/' } });
    const href = requests.find(request => request.message).message.html.match(/href="([^"]+)"/)[1]; const url = new URL(href); assert.equal(url.pathname, '/prefix/referrals/reset'); assert.equal(new URLSearchParams(url.hash.slice(1)).get('token'), 'fixture-token'); return { href };
  });
  evidence.ok = evidence.scenarios.length > 0 && evidence.scenarios.every(item => item.passed);
} catch (error) { evidence.ok = false; evidence.failure = { message: error.message, stack: error.stack }; }
finally { globalThis.fetch = nativeFetch; for (const instance of [server, otherServer]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); } fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`); process.stdout.write(`${JSON.stringify({ ok: evidence.ok, scenarios: evidence.scenarios.map(({ name, passed, error }) => ({ name, passed, error })), failure: evidence.failure, artifact })}\n`); }
if (!evidence.ok) process.exitCode = 1;
