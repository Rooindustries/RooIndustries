import os from "node:os";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { start } from './lib/storage-fixture.mjs';
const artifact = { startedAt: new Date().toISOString(), passed: false, checks: [] };
let stack;
try {
  stack = await start({ fullMigrationChain: true });
  artifact.versions = stack.versions;
  artifact.migrations = stack.manifest;
  const files = fs.readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual(stack.manifest.map(item => item.file.split('/').at(-1)), files);
  assert.ok(stack.manifest.every(item => item.selection === 'complete migration'));
  artifact.checks.push('all sorted migrations applied whole, including new release');
  const { data, error } = await stack.client.rpc('roo_apply_cms_publish_command', {
    p_command_id: `cms:${'a'.repeat(64)}`, p_request_hash: 'a'.repeat(64), p_actor: 'admin:key',
    p_mutations: [{ operation: 'create', document: { _id: 'stack-review', _type: 'review', title: 'Synthetic stack content' } }], p_assets: [], p_asset_links: [],
  });
  assert.equal(error, null); assert.ok(data.results[0]._rev);
  artifact.checks.push('actual service-role PostgREST admin publish returns committed revision');
  const uploadId = crypto.randomUUID();
  const declaration = { uploadId, kind: 'image', fileName: 'fixture.png', mimeType: 'image/png', byteSize: 68, sha1: '1'.repeat(40), sha256: '2'.repeat(64), width: 1, height: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const issued = await stack.client.rpc('roo_create_cms_upload', { p_upload: declaration });
  assert.equal(issued.error, null); assert.equal(issued.data.width, 1); assert.equal(issued.data.path, `uploads/${uploadId}`);
  const signed = await stack.client.storage.from(issued.data.bucket).createSignedUploadUrl(issued.data.path, { upsert: false });
  assert.equal(signed.error, null);
  const [bucket] = await stack.sql`select public,file_size_limit,allowed_mime_types from storage.buckets where id='cms-upload-staging'`;
  assert.equal(bucket.public, false); assert.equal(Number(bucket.file_size_limit), 67108864); assert.ok(bucket.allowed_mime_types.includes('image/png') && bucket.allowed_mime_types.includes('application/zip'));
  artifact.checks.push('actual official Storage staging bucket private, 64 MiB, signs durable path');
  const refused = await stack.client.rpc('roo_refuse_cms_upload', { p_upload_id: uploadId, p_error_code: 'ASSET_VERIFICATION_FAILED' });
  assert.equal(refused.error, null); assert.equal(refused.data.status, 'refused');
  const browserDenied = await fetch(`${stack.supabaseUrl}/rest/v1/rpc/roo_get_cms_upload`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: stack.anonKey, authorization: `Bearer ${stack.anonKey}` }, body: JSON.stringify({ p_upload_id: uploadId }), signal: AbortSignal.timeout(5000) });
  assert.equal(browserDenied.status, 401);
  artifact.checks.push('actual anonymous PostgREST access refused');
  const baselineFiles = new Map();
  const baselineDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'roo-old-app-cjs-'));
  for (const name of ['envValue.cjs','sanityConfiguration.cjs']) {
    const key = `src/server/supabase/${name}`;
    const source = execFileSync('git',['show',`b5c72601:${key}`],{encoding:'utf8'});
    baselineFiles.set(key,source);
    fs.writeFileSync(path.join(baselineDirectory,name),source);
  }
  const baseline = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('roo-baseline:')) return {url:new URL('../'+specifier.slice(13),import.meta.url).href,shortCircuit:true};
      if (specifier.startsWith('.') && ['envValue.cjs','sanityConfiguration.cjs'].includes(path.basename(specifier))) return {url:new URL('file://' + path.join(baselineDirectory,path.basename(specifier))).href,shortCircuit:true};
      if (specifier === '@sanity/client') return { url: 'roo-old-app:forbidden-vendor-constructor', shortCircuit: true };
      try { return next(specifier, context); } catch (error) {
        if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) return { url: new URL(specifier + (path.extname(specifier) ? '' : '.js'), context.parentURL).href, shortCircuit: true };
        throw error;
      }
    },
    load(url, context, next) {
      if (url === 'roo-old-app:forbidden-vendor-constructor') return {format:'module',source:"export const createClient = () => { throw new Error('Old vendor construction attempted'); };",shortCircuit:true};
      if (!url.startsWith('file:')) return next(url, context);
      const name = path.relative(process.cwd(), fileURLToPath(url));
      if (!name.startsWith('src/')) return next(url, context);
      if (!baselineFiles.has(name)) baselineFiles.set(name, execFileSync('git', ['show', `b5c72601:${name}`], { encoding: 'utf8' }));
      const source = baselineFiles.get(name);
      return { format: /(?:^|\n)\s*(import |export )/.test(source) ? 'module' : 'commonjs', source, shortCircuit: true };
    },
  });
  try {
    const { drainCommerceMirrorOutbox } = await import('roo-baseline:src/server/supabase/commerceMirrorOutbox.js');
    const { drainDocumentMutationOutbox } = await import('roo-baseline:src/server/supabase/documentMutationOutbox.js');
    let vendorCalls = 0;
    const forbiddenVendor = { transaction() { vendorCalls++; throw new Error('Retired vendor write attempted'); }, fetch() { vendorCalls++; throw new Error('Retired vendor read attempted'); } };
    const options = { supabaseClient: stack.client, sanityClient: forbiddenVendor, limit: 1, maxBatches: 1, failClosed: true };
    const commerce = await drainCommerceMirrorOutbox(options);
    const documents = await drainDocumentMutationOutbox(options);
    assert.equal(commerce.attempted, 0); assert.equal(commerce.mirrored, 0); assert.equal(commerce.failed, 0);
    assert.equal(documents.attempted, 0); assert.equal(documents.applied, 0); assert.equal(documents.errorCode, undefined); assert.equal(documents.pending, undefined); assert.equal(documents.backlog.pending, 0); assert.equal(documents.backlog.retired, true);
    const { resumeSupabaseCredentialOperation } = await import('../src/server/supabase/credentialRecovery.js');
    const userId = crypto.randomUUID(), operationKey = 'old-app-mirror-only', passwordHash = '$2b$12$' + 'A'.repeat(53);
    await stack.sql`insert into auth.users(id,email,encrypted_password) values(${userId},'credential-stack@example.test',${passwordHash})`;
    const bootstrap = await stack.client.rpc('roo_bootstrap_native_account', { p_user_id: userId }); assert.equal(bootstrap.error, null);
    const [{ principal_id: principalId }] = await stack.sql`select principal_id from accounts.principal_auth_users where user_id=${userId}`;
    const mutation = { set: { creatorPassword: passwordHash, credentialVersion: 2, passwordLoginEnabled: true, passwordResetRequired: false, passwordChangedAt: '2026-01-01T00:00:00Z' }, unset: ['resetTokenHash'] };
    const sourceDocument = { _id: 'old-app-credential-source', _type: 'referral', _rev: 'old-app-source-r1', slug: { current: 'oldappcredential' }, ...mutation.set };
    await stack.sql`insert into migration.source_documents(legacy_sanity_id,document_type,source_revision,source_hash,payload,backend_owner) values('old-app-credential-source','referral','old-app-source-r1',repeat('4',64),${stack.sql.json(sourceDocument)},'sanity')`;
    await stack.sql`insert into accounts.credential_operations(operation_key,user_id,principal_id,password_hash,status,source_backend,source_document_id,source_expected_revision,source_preconditions,source_mutation,source_applied_revision,source_applied_at,sessions_revoked_at,attempt_count,source_recovery_blocked,source_recovery_blocked_at,next_retry_at,last_error_code,last_error_class) values(${operationKey},${userId},${principalId},${passwordHash},'auth_applied','sanity','old-app-credential-source','old-app-source-r1','{"creatorPassword":"old","credentialVersion":1}',${stack.sql.json(mutation)},'old-app-source-r1',now(),now(),6,true,now(),now()+interval '1 hour','CREDENTIAL_MIRROR_PENDING','transient')`;
    const authBefore = await stack.sql`select to_jsonb(u) record from auth.users u where id=${userId}`;
    const oldCredentialRetry = await resumeSupabaseCredentialOperation({ operationKey, adminClient: stack.client, sanityClient: forbiddenVendor });
    assert.equal(oldCredentialRetry.resumed, true);
    const [credential] = await stack.sql`select status,source_backend,attempt_count,source_recovery_blocked from accounts.credential_operations where operation_key=${operationKey}`;
    assert.equal(credential.status, 'mirrored'); assert.equal(credential.source_backend, 'sanity'); assert.equal(credential.source_recovery_blocked, false);
    assert.deepEqual(await stack.sql`select to_jsonb(u) record from auth.users u where id=${userId}`, authBefore);
    artifact.oldCredentialRetry = { oldResponse: oldCredentialRetry, persisted: credential, authUnchanged: true };
    artifact.checks.push('actual b5c72601 request retry completes legacy blocked credential against native SQL without repeating Auth or calling vendor');
    assert.equal(vendorCalls, 0);
    artifact.oldApp = { commit: 'b5c72601', vendorSdkImport: 'explicit forbidden constructor stand-in; actual old helper sources and SQL exercised', commerce, documents, vendorCalls, sourceHashes: Object.fromEntries([...baselineFiles].map(([name, source]) => [name, crypto.createHash('sha256').update(source).digest('hex')])) };
    artifact.checks.push('actual b5c72601 old drainers accept empty retired work with zero vendor calls and zero fabricated deliveries');
  } finally { baseline.deregister(); }
  artifact.passed = true;
} catch (error) { artifact.error = error.message; throw error; }
finally {
  if (stack) artifact.cleanup = await stack.stop();
  artifact.endedAt = new Date().toISOString();
  fs.mkdirSync('test-results/sanity-sql', { recursive: true });
  fs.writeFileSync('test-results/sanity-sql/stack.json', JSON.stringify(artifact, null, 2));
  process.stdout.write(JSON.stringify({ passed: artifact.passed, artifact: 'test-results/sanity-sql/stack.json', error: artifact.error }) + '\n');
}
