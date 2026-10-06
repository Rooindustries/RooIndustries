import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
registerHooks({ resolve(specifier, context, next) { if (specifier.startsWith('@/')) specifier = pathToFileURL(path.join(root, specifier.slice(2))).href; try { return next(specifier, context); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('.') || specifier.startsWith('file:')) && !path.extname(specifier)) return next(specifier + '.js', context); throw error; } } });
const R = p => pathToFileURL(path.join(root, p)).href;
const req = createRequire(path.join(root, 'package.json'));
const sharp = req('sharp');
const { start } = await import(R('scripts/lib/storage-fixture.mjs'));

const out = { steps: [], passed: false, sourceRepro:'review-legacy-asset.mjs exact8x6 PNG and full Sanity-shaped source metadata' };
let fixture;
try {
  for (const key of Object.keys(process.env)) if (/SANITY_|^(SUPABASE|NEXT_PUBLIC_|PAYPAL|RAZORPAY|DODO|COMMERCE_|DATA_|REF_|CRON_|RATE_LIMIT_|RESEND)/.test(key)) delete process.env[key];
  fixture = await start({ fullMigrationChain: true });
  Object.assign(process.env, { NODE_ENV: 'test', VERCEL_ENV: 'development', SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_URL: fixture.origin, SUPABASE_SECRET_KEY: fixture.token, SUPABASE_SERVICE_ROLE_KEY: fixture.token, DATA_PRIMARY_BACKEND: 'supabase', COMMERCE_PRIMARY_BACKEND: 'supabase', COMMERCE_FAILOVER_GENERATION: '0', SUPABASE_CUTOVER_ENABLED: '1', COMMERCE_CUTOVER_ENABLED: '1', CMS_WRITES_PAUSED: '0', REF_ADMIN_KEY: 'review-admin-key' });
  const { client, sql } = fixture;
  const { issueCmsUpload, finalizeCmsUpload } = await import(R('src/server/cms/assets.js'));
  const png = await sharp({ create: { width: 8, height: 6, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 1 } } }).png().toBuffer();
  const sha1 = crypto.createHash('sha1').update(png).digest('hex'), sha256 = crypto.createHash('sha256').update(png).digest('hex');
  const assetId = `image-${sha1}-8x6-png`;
  // Seed a legacy-shaped (Sanity-imported) asset: storage object, cms.assets row, and Sanity-shaped asset source document.
  const seeded = await client.storage.from('site-content-public').upload(`images/${sha1}.png`, png, { contentType: 'image/png', upsert: false });
  out.steps.push({ step: 'seed legacy storage object', error: seeded.error?.message || null });
  const upsert = await client.rpc('roo_upsert_asset', { p_asset: { legacy_sanity_asset_id: assetId, source_url: `https://cdn.sanity.io/images/9g42k3ur/production/${sha1}-8x6.png`, storage_bucket: 'site-content-public', storage_path: `images/${sha1}.png`, mime_type: 'image/png', byte_size: png.length, sha256, width: 8, height: 6, metadata: {} } });
  out.steps.push({ step: 'seed legacy cms.assets row', error: upsert.error?.message || null });
  const doc = { _id: assetId, _type: 'sanity.imageAsset', _rev: 'legacyrev1', _createdAt: '2025-01-01T00:00:00Z', _updatedAt: '2025-01-01T00:00:00Z', assetId: sha1, extension: 'png', mimeType: 'image/png', originalFilename: 'logo.png', path: `images/9g42k3ur/production/${sha1}-8x6.png`, sha1hash: sha1, size: png.length, uploadId: 'legacyUpload', url: `https://cdn.sanity.io/images/9g42k3ur/production/${sha1}-8x6.png`, metadata: { _type: 'sanity.imageMetadata', blurHash: 'abc', dimensions: { _type: 'sanity.imageDimensions', aspectRatio: 8 / 6, height: 6, width: 8 }, hasAlpha: true, isOpaque: true, lqip: 'data:image/jpeg;base64,xx', palette: { _type: 'sanity.imagePalette' } } };
  const create = await client.rpc('roo_apply_document_mutations', { p_mutations: [{ operation: 'create', document: doc }] });
  out.steps.push({ step: 'seed legacy asset source doc', error: create.error?.message || null });
  // Now an editor uploads the byte-identical image through the new admin flow.
  const env = process.env;
  const body={kind:'image',fileName:'logo.png',mimeType:'image/png',byteSize:png.length,sha1,sha256,width:8,height:6};
  const [sourceBefore]=await sql`select to_jsonb(s) row from migration.source_documents s where legacy_sanity_id=${assetId}`;
  const [countBefore]=await sql`select count(*)::integer n from cms.uploads`;
  const fast=await issueCmsUpload({body,client,env});assert.equal(fast.alreadyExists,true);assert.equal(fast.uploadId,null);assert.equal(fast.assetId,assetId);assert.equal(fast.width,8);assert.equal(fast.height,6);assert.ok(fast.url.startsWith(fixture.origin));assert.equal((await sql`select count(*)::integer n from cms.uploads`)[0].n,countBefore.n);out.steps.push({step:'verified fast path no staging',assetId:fast.assetId,alreadyExists:true,uploadId:null});
  await sql`update cms.assets set migration_status='copied' where legacy_sanity_asset_id=${assetId}`;
  const issued=await issueCmsUpload({body,client,env});assert.ok(issued.uploadId);const put=await fetch(issued.signedUrl,{method:'PUT',headers:{'content-type':'image/png','x-upsert':'false'},body:png});assert.equal(put.status,200);
  const finalized=await finalizeCmsUpload({body:{uploadId:issued.uploadId},client,env,signal:AbortSignal.timeout(120000)});assert.equal(finalized.assetId,assetId);assert.equal(finalized.reused,true);assert.equal((await sql`select sha256 from cms.assets where legacy_sanity_asset_id=${assetId}`)[0].sha256,sha256);assert.deepEqual((await sql`select to_jsonb(s) row from migration.source_documents s where legacy_sanity_id=${assetId}`)[0],sourceBefore);out.steps.push({step:'no verified SHA256 match (copied manifest) full finalize reuse',assetId:finalized.assetId,legacySourceAllColumnsUnchanged:true});
  await sql`delete from cms.assets where legacy_sanity_asset_id=${assetId}`;
  const missingManifest=await issueCmsUpload({body,client,env});assert.ok(missingManifest.uploadId);assert.equal((await fetch(missingManifest.signedUrl,{method:'PUT',headers:{'content-type':'image/png','x-upsert':'false'},body:png})).status,200);
  const registered=await finalizeCmsUpload({body:{uploadId:missingManifest.uploadId},client,env});assert.equal(registered.assetId,assetId);assert.equal(registered.reused,true);assert.deepEqual((await sql`select to_jsonb(s) row from migration.source_documents s where legacy_sanity_id=${assetId}`)[0],sourceBefore);out.steps.push({step:'no manifest/SHA256 match final bytes and legacy source reused',assetId,legacySourceAllColumnsUnchanged:true});
  await sql`update migration.source_documents set payload=jsonb_set(payload,'{sha1hash}',${sql.json('0'.repeat(40))}) where legacy_sanity_id=${assetId}`;
  await assert.rejects(issueCmsUpload({body,client,env}),error=>error.code==='CMS_ASSET_SOURCE_COLLISION'&&error.status===422);
  await sql`update cms.assets set migration_status='copied' where legacy_sanity_asset_id=${assetId}`;
  const collision=await issueCmsUpload({body,client,env});assert.equal((await fetch(collision.signedUrl,{method:'PUT',headers:{'content-type':'image/png','x-upsert':'false'},body:png})).status,200);
  await assert.rejects(finalizeCmsUpload({body:{uploadId:collision.uploadId},client,env}),error=>error.code==='CMS_ASSET_SOURCE_COLLISION'&&error.status===422);
  const [refused]=await sql`select status,last_error_code from cms.uploads where upload_id=${collision.uploadId}`;assert.equal(refused.status,'refused');assert.equal(refused.last_error_code,'CMS_ASSET_SOURCE_COLLISION');assert.equal(Number((await client.storage.from(collision.bucket).info(collision.path)).error.statusCode),404);
  const finalBytes=await client.storage.from('site-content-public').download(`images/${sha1}.png`);assert.equal(crypto.createHash('sha256').update(Buffer.from(await finalBytes.data.arrayBuffer())).digest('hex'),sha256);out.steps.push({step:'true source collision own code',refused,sharedFinalUnchanged:true});out.passed=true;
} catch (error) {
  out.error = { message: error.message, stack: error.stack };
} finally {
  out.stopped = await fixture?.stop?.();
}
fs.mkdirSync('test-results/sanity-fixround',{recursive:true});fs.writeFileSync('test-results/sanity-fixround/R2-legacy-asset-reuse.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));if(!out.passed)process.exitCode=1;
