import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { start } from './lib/storage-fixture.mjs';

const output = path.resolve('test-results/storage-fixture-smoke.json');
const artifact = { startedAt: new Date().toISOString(), scenario: 'storage-fixture-smoke', observations: [], requests: [], standIns: ['Loopback reverse proxy stands in for Kong.', 'Synthetic auth schema; no GoTrue.', 'Official local Storage release does not establish hosted Storage version behavior.'] };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clean = value => {
  if (value instanceof Error) return clean({ name: value.name, message: value.message, status: value.status, statusCode: value.statusCode });
  if (typeof value === 'string') return value.replace(/([?&]token=)[^&\s]+/g, '$1[redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]');
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(token|signedURL|signedUrl)$/i.test(key) ? '[redacted]' : clean(item)]));
  return value;
};
const record = (name, value) => { artifact.observations.push({ name, response: clean(value) }); return value; };
let fixture;
try {
  assert.ok(process.argv.slice(2).every(arg => arg === '--scenario=storage-fixture-smoke'), 'Unknown scenario');
  fixture = await start({ signedUploadExpirationSeconds: 3 });
  artifact.versions = fixture.versions;
  artifact.ports = fixture.ports;
  artifact.migrations = fixture.manifest.map(({ appliedSql, ...entry }) => entry);
  artifact.storageMigrations = fixture.storageMigrations;
  artifact.buckets = await fixture.sql`select id,name,public,file_size_limit,allowed_mime_types from storage.buckets order by id`;
  assert.deepEqual(artifact.buckets.map(row => [row.id, row.public, Number(row.file_size_limit)]), [['optimization-builds-private', false, 2147483648], ['site-content-public', true, 20971520]]);
  assert.deepEqual(artifact.buckets[0].allowed_mime_types, ['application/zip', 'application/x-zip-compressed', 'application/octet-stream', 'application/vnd.microsoft.portable-executable', 'application/x-msdownload']);
  assert.deepEqual(artifact.buckets[1].allowed_mime_types, ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/svg+xml']);
  const trackedFetch = async (input, init) => {
    const response = await fetch(input, init);
    const entry = { method: init?.method || 'GET', url: clean(String(input)), status: response.status, headers: Object.fromEntries(response.headers), body: null };
    if (response.headers.get('content-type')?.includes('json')) entry.body = clean(await response.clone().json());
    else if (!response.ok) entry.body = clean(await response.clone().text());
    artifact.requests.push(entry);
    return response;
  };
  const client = createClient(fixture.supabaseUrl, fixture.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: trackedFetch } });
  const anon = createClient(fixture.supabaseUrl, fixture.anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: trackedFetch } });
  const rpc = record('rpc-through-gateway', await client.rpc('roo_commerce_control'));
  assert.equal(rpc.error, null);
  let hooked = false;
  fixture.setRequestHook(phase => { if (phase === 'after') hooked = true; });
  assert.equal((await client.rpc('roo_commerce_control')).error, null);
  assert.equal(hooked, true);
  fixture.setRequestHook(null);
  record('inherited-sweep-rpc-hook-through-gateway', { observed: hooked });
  fixture.setAuthHandler(() => ({ status: 200, body: { fixture: 'synthetic-auth-handler' } }));
  const authControl = await trackedFetch(`${fixture.supabaseUrl}/auth/v1/fixture-control`);
  assert.equal(authControl.status, 200);
  record('synthetic-auth-handler-through-gateway', await authControl.json());
  fixture.setAuthHandler(null);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8WQAAAAASUVORK5CYII=', 'base64');
  const zip = Buffer.from('UEsDBBQAAAAAAAAAIVAhpYXdFwAAABcAAAALAAAAZml4dHVyZS50eHRSb28gSW5kdXN0cmllcyBmaXh0dXJlClBLAQIUAxQAAAAAAAAAIVAhpYXdFwAAABcAAAALAAAAAAAAAAAAAACAAQAAAABmaXh0dXJlLnR4dFBLBQYAAAAAAQABADkAAABAAAAAAAA=', 'base64');
  const signed = async (bucket, objectPath, options) => {
    const result = record(`sign:${bucket}/${objectPath}${options?.upsert ? ':upsert' : ''}`, await client.storage.from(bucket).createSignedUploadUrl(objectPath, options));
    assert.equal(result.error, null);
    return result.data;
  };
  const upload = async (name, bucket, objectPath, bytes, mime, { token, upsert } = {}) => {
    const url = token ? { token } : await signed(bucket, objectPath, { upsert });
    return record(name, await anon.storage.from(bucket).uploadToSignedUrl(objectPath, url.token, bytes, { contentType: mime, upsert: Boolean(upsert) }));
  };
  const inspect = async (bucket, objectPath, expectedBytes) => {
    const info = record(`info:${bucket}/${objectPath}`, await client.storage.from(bucket).info(objectPath));
    assert.equal(info.error, null);
    const download = await client.storage.from(bucket).download(objectPath);
    assert.equal(download.error, null);
    const bytes = Buffer.from(await download.data.arrayBuffer());
    record(`download:${bucket}/${objectPath}`, { byteSize: bytes.length, sha256: digest(bytes), blobType: download.data.type, firstBytesHex: bytes.subarray(0, 16).toString('hex') });
    assert.equal(info.data.size, bytes.length);
    assert.ok(info.data.etag);
    if (expectedBytes) assert.deepEqual(bytes, expectedBytes);
    return { info, bytes };
  };
  const publicBucket = 'site-content-public', privateBucket = 'optimization-builds-private';
  const original = await signed(publicBucket, 'images/smoke.png');
  assert.equal((await upload('signed-image-upload', publicBucket, original.path, png, 'image/png', original)).error, null);
  assert.equal((await upload('same-token-reuse-without-upsert', publicBucket, original.path, zip, 'image/png', original)).error?.statusCode, '409');
  assert.equal((record('same-path-second-sign-without-upsert', await client.storage.from(publicBucket).createSignedUploadUrl(original.path))).error?.statusCode, '409');
  await inspect(publicBucket, original.path, png);
  const overwrite = await signed(publicBucket, original.path, { upsert: true });
  assert.equal((await upload('same-path-with-signed-upsert', publicBucket, original.path, zip, 'image/png', overwrite)).error, null);
  await inspect(publicBucket, original.path, zip);
  assert.equal((await upload('same-upsert-token-reused-after-success', publicBucket, original.path, png, 'image/png', overwrite)).error, null);
  await inspect(publicBucket, original.path, png);
  const noUpsert = await signed(publicBucket, 'images/sdk-upsert.png');
  assert.equal((await upload('unsigned-sdk-upsert-control-first', publicBucket, noUpsert.path, png, 'image/png', noUpsert)).error, null);
  assert.equal((await upload('sdk-upsert-cannot-upgrade-token', publicBucket, noUpsert.path, zip, 'image/png', { ...noUpsert, upsert: true })).error?.statusCode, '409');
  await inspect(publicBucket, noUpsert.path, png);
  assert.equal((await upload('disallowed-html-mime-and-bytes', publicBucket, 'images/html.png', Buffer.from('<html>fixture</html>'), 'text/html')).error?.statusCode, '415');
  assert.equal((record('rejected-html-object-info', await client.storage.from(publicBucket).info('images/html.png'))).data, null);
  assert.equal((await upload('png-bytes-zip-header-public', publicBucket, 'images/png-as-zip.png', png, 'application/zip')).error?.statusCode, '415');
  assert.equal((await upload('zip-bytes-png-header-public', publicBucket, 'images/zip-as-png.png', zip, 'image/png')).error, null);
  await inspect(publicBucket, 'images/zip-as-png.png', zip);
  assert.equal((await upload('png-bytes-zip-header-private', privateBucket, 'builds/png-as-zip.zip', png, 'application/zip')).error, null);
  await inspect(privateBucket, 'builds/png-as-zip.zip', png);
  assert.equal((record('create-small-size-test-bucket', await client.storage.createBucket('fixture-small', { public: false, fileSizeLimit: 1024, allowedMimeTypes: ['image/png'] }))).error, null);
  assert.equal((await upload('small-bucket-limit-plus-one', 'fixture-small', 'oversize.png', Buffer.alloc(1025), 'image/png')).error?.statusCode, '413');
  assert.equal((record('rejected-small-oversize-object-info', await client.storage.from('fixture-small').info('oversize.png'))).data, null);
  const imageOver = Buffer.alloc(20971521); png.copy(imageOver);
  assert.equal((await upload('real-public-limit-plus-one', publicBucket, 'images/oversize.png', imageOver, 'image/png')).error?.statusCode, '413');
  assert.equal((record('rejected-public-oversize-object-info', await client.storage.from(publicBucket).info('images/oversize.png'))).data, null);
  const tusHeaders = token => ({ 'tus-resumable': '1.0.0', 'x-signature': token, apikey: fixture.anonKey });
  const tusCreate = async (bucket, objectPath, length) => {
    const token = (await signed(bucket, objectPath)).token;
    const metadata = Object.entries({ bucketName: bucket, objectName: objectPath, contentType: bucket === privateBucket ? 'application/zip' : 'image/png', cacheControl: '3600' }).map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`).join(',');
    const response = await trackedFetch(`${fixture.supabaseUrl}/storage/v1/upload/resumable/sign`, { method: 'POST', headers: { ...tusHeaders(token), 'upload-length': String(length), 'upload-metadata': metadata } });
    record(`tus-create:${bucket}/${objectPath}`, { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text(), declaredBytes: length });
    return { response, token };
  };
  assert.equal((await tusCreate(privateBucket, 'builds/oversize.zip', 2147483649)).response.status, 413);
  const tus = await tusCreate(publicBucket, 'images/tus.png', png.length);
  assert.equal(tus.response.status, 201);
  const location = tus.response.headers.get('location');
  assert.ok(location.startsWith(fixture.supabaseUrl + '/storage/v1/'));
  const head = await trackedFetch(location, { method: 'HEAD', headers: tusHeaders(tus.token) });
  record('tus-head-before-upload', { status: head.status, headers: Object.fromEntries(head.headers) });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('upload-offset'), '0');
  const partialBytes = Math.floor(png.length / 2);
  const partial = await trackedFetch(location, { method: 'PATCH', headers: { ...tusHeaders(tus.token), 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, body: png.subarray(0, partialBytes) });
  record('tus-signed-partial-patch', { status: partial.status, headers: Object.fromEntries(partial.headers), body: await partial.text() });
  assert.equal(partial.status, 204);
  assert.equal(partial.headers.get('upload-offset'), String(partialBytes));
  const resume = await trackedFetch(location, { method: 'HEAD', headers: tusHeaders(tus.token) });
  record('tus-head-before-resume', { status: resume.status, headers: Object.fromEntries(resume.headers) });
  assert.equal(resume.status, 200);
  assert.equal(resume.headers.get('upload-offset'), String(partialBytes));
  const patch = await trackedFetch(location, { method: 'PATCH', headers: { ...tusHeaders(tus.token), 'upload-offset': String(partialBytes), 'content-type': 'application/offset+octet-stream' }, body: png.subarray(partialBytes) });
  record('tus-signed-resume-patch', { status: patch.status, headers: Object.fromEntries(patch.headers), body: await patch.text() });
  assert.equal(patch.status, 204);
  assert.equal(patch.headers.get('upload-offset'), String(png.length));
  await inspect(publicBucket, 'images/tus.png', png);
  const expiring = await signed(publicBucket, 'images/expired.png');
  const claims = JSON.parse(Buffer.from(expiring.token.split('.')[1], 'base64url'));
  await new Promise(resolve => setTimeout(resolve, Math.max(0, claims.exp * 1000 - Date.now() + 1100)));
  record('expired-token-timing', { issuedAt: claims.iat, expiresAt: claims.exp, attemptAt: Math.floor(Date.now() / 1000) });
  const expiredUpload = await upload('expired-signed-upload-token', publicBucket, expiring.path, png, 'image/png', expiring);
  assert.equal(expiredUpload.error?.statusCode, '400');
  assert.match(expiredUpload.error.message, /exp.*claim timestamp check failed/);
  assert.equal((record('expired-token-object-info', await client.storage.from(publicBucket).info(expiring.path))).data, null);
  const forbidden = ['https://toolingfixture.api.sanity.io/v1/data/query/test', 'https://toolingfixture.apicdn.sanity.io/v1/data/query/test', 'https://cdn.sanity.io/images/test.png', 'https://rooindustries.sanity.studio/', 'https://example.com/'];
  for (const url of forbidden) {
    await assert.rejects(fetch(url), /\[test-target\]/);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import https from 'node:https'; const url=${JSON.stringify(url)}; const messages=[]; try{await fetch(url);process.exitCode=1}catch(e){messages.push(e.message)} try{https.get(url);process.exitCode=1}catch(e){messages.push(e.message)} console.log(JSON.stringify(messages));`], { cwd: fixture.scratch, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const messages = JSON.parse(result.stdout);
    assert.equal(messages.length, 2);
    assert.ok(messages.every(message => message.includes('[test-target]')));
    record('parent-and-inherited-child-network-refusal', { url, childMessages: messages });
  }
  artifact.objects = await fixture.sql`select bucket_id,name,metadata from storage.objects order by bucket_id,name`;
  record('no-application-asset-registration-in-baseline', await fixture.sql`select count(*)::integer as registered_assets from cms.assets`);
  const stopped = await fixture.stop();
  assert.equal(stopped.storageExited && stopped.postgresExited && stopped.postgrestExited && stopped.storageScratchRemoved && stopped.databaseScratchRemoved, true);
  assert.deepEqual(await fixture.stop(), stopped);
  record('idempotent-stop-cleans-owned-pids-and-directories', stopped);
  try {
    await start({ afterMigrations() { throw new Error('fixture-intentional-start-failure'); } });
    assert.fail('Intentional startup failure unexpectedly succeeded');
  } catch (error) {
    assert.equal(error.message, 'fixture-intentional-start-failure');
    assert.equal(error.cleanup.storageExited && error.cleanup.postgresExited && error.cleanup.postgrestExited && error.cleanup.storageScratchRemoved && error.cleanup.databaseScratchRemoved, true);
    record('startup-failure-cleans-owned-pids-and-directories', error.cleanup);
  }
  try {
    await start({ pgBin: '/tmp/roo-storage-api-v1.79.33/missing-pg-bin' });
    assert.fail('Missing PostgreSQL binary unexpectedly succeeded');
  } catch (error) {
    assert.match(error.message, /postgres failed/);
    assert.equal(error.cleanup.storageScratchRemoved && error.cleanup.databaseScratchRemoved, true);
    record('missing-postgres-binary-cleans-owned-directories', error.cleanup);
  }
  const files = ['scripts/lib/storage-fixture.mjs', 'scripts/test-storage-fixture-smoke.mjs', 'scripts/lib/sweep-postgres-fixture.mjs', 'scripts/lib/test-target-safety.mjs'];
  artifact.sourceSha256 = Object.fromEntries(files.map(file => [file, digest(fs.readFileSync(file))]));
  artifact.passed = true;
} catch (error) {
  artifact.passed = false;
  artifact.error = { message: clean(error.message), stack: clean(error.stack), storageLog: clean(error.storageLog), cleanup: error.cleanup };
  process.exitCode = 1;
} finally {
  try { if (fixture) artifact.cleanup = await fixture.stop(); }
  catch (error) { artifact.passed = false; artifact.cleanupError = clean(error.message); process.exitCode = 1; }
  artifact.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + '\n');
  console.log(JSON.stringify({ passed: artifact.passed, observations: artifact.observations.length, output, cleanup: artifact.cleanup, error: artifact.error?.message }));
}
