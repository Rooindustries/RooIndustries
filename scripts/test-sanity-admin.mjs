import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { start } from './lib/storage-fixture.mjs';
const root = path.resolve('.');
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) specifier = pathToFileURL(path.join(root, specifier.slice(2))).href;
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('.') || specifier.startsWith('file:')) && !path.extname(specifier)) return next(specifier + '.js', context);
    throw error;
  }
} });
const selected = process.argv.find(arg => arg.startsWith('--scenario='))?.slice(11) || 'all';
const artifact = { selected, startedAt: new Date().toISOString(), scenarios: [], transport: 'Actual exported app route handlers receive native Request/Response; Next HTTP router/build not exercised. PostgreSQL17/PostgREST/official Storage persistence is native.', observations: [], passed: false };
const observed = (name, value) => artifact.observations.push({ name, value });
const sanitize = value => Array.isArray(value) ? value.map(sanitize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(token|uploadToken|serviceRoleKey|anonKey)$/.test(key) ? '[redacted]' : sanitize(item)])) : typeof value === 'string' && /^https?:/.test(value) ? (() => { const url = new URL(value); for (const key of ['token','signature']) if (url.searchParams.has(key)) url.searchParams.set(key, '[redacted]'); return url.toString(); })() : value;
const hashes = bytes => ({ sha1: crypto.createHash('sha1').update(bytes).digest('hex'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6a0AAAAASUVORK5CYII=', 'base64');
const zip = Buffer.from('UEsDBBQAAAAAAAAAIVAhpYXdFwAAABcAAAALAAAAZml4dHVyZS50eHRSb28gSW5kdXN0cmllcyBmaXh0dXJlClBLAQIUAxQAAAAAAAAAIVAhpYXdFwAAABcAAAALAAAAAAAAAAAAAACAAQAAAABmaXh0dXJlLnR4dFBLBQYAAAAAAQABADkAAABAAAAAAAA=', 'base64');
let fixture;
const completed = new Map();
try {
  for (const key of Object.keys(process.env)) if (/(^|_)SANITY_/.test(key)) delete process.env[key];
  if(selected==='all')artifact.schema=JSON.parse(execFileSync(process.execPath,['scripts/test-sanity-admin-schema.mjs','--scenario=schema'],{encoding:'utf8'}).trim());
  fixture = await start({ fullMigrationChain: true, signedUploadExpirationSeconds: 2 });
  artifact.versions = fixture.versions;
  artifact.runtime = { storageScratch: fixture.scratch, databaseScratch: fixture.databaseScratch, postgresPid: Number(fs.readFileSync(path.join(fixture.databaseScratch, 'data/postmaster.pid'), 'utf8').split('\n')[0]), postgrestPid: fixture.postgrestPid };
  fs.mkdirSync('test-results/sanity-admin', { recursive: true }); fs.writeFileSync(`test-results/sanity-admin/${selected}.json`, JSON.stringify(sanitize(artifact), null, 2) + '\n');
  artifact.migrations = fixture.manifest.map(({ file, selection, sha256 }) => ({ file, selection, sha256 }));
  const expectedFiles = fs.readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort();
  assert.deepEqual(fixture.manifest.map(row => path.basename(row.file)).sort(), expectedFiles, 'Full migration chain required');
  assert.ok(fixture.manifest.every(row => row.selection === 'complete migration'), 'Selective migration fixture does not prove full chain');
  Object.assign(process.env, { REF_ADMIN_KEY: 'synthetic-admin-key', RATE_LIMIT_HASH_SECRET: 'synthetic-admin-fixture-rate-secret', CMS_WRITES_PAUSED: '0', SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_URL: fixture.origin, SUPABASE_SERVICE_ROLE_KEY: fixture.token, SUPABASE_SECRET_KEY: fixture.token, DATA_PRIMARY_BACKEND: 'supabase', COMMERCE_PRIMARY_BACKEND: 'supabase', COMMERCE_FAILOVER_GENERATION: '0', SUPABASE_CUTOVER_ENABLED: '1', COMMERCE_CUTOVER_ENABLED: '1' });
  const modules = {};
  for (const name of ['documents','documents/[id]','documents/[id]/revisions','documents/[id]/revisions/[revisionId]','publish','assets/upload','assets/finalize']) modules[name] = await import(`../app/api/admin/content/${name}/route.js`);
  const tools = await import('../app/api/tools/[id]/download/route.js');
  const publicRoute = await import('../app/api/content/[resource]/route.js');
  const call = async (name, body, params = {}, key = 'synthetic-admin-key', address = '127.0.0.1') => {
    const method = body === undefined ? 'GET' : 'POST';
    const headers = { 'Content-Type': 'application/json', 'x-forwarded-for': address, ...(key ? { 'x-admin-key': key } : {}) };
    const request = new Request(`${fixture.origin}/api/admin/content/${name}${params.type ? '?type=' + encodeURIComponent(params.type) : ''}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await modules[name][method](request, { params: Promise.resolve(params) });
    const result = await response.json();
    assert.match(response.headers.get('Cache-Control'), /private, no-store/);
    observed(name, { status: response.status, result: sanitize(result) });
    return { status: response.status, ...result };
  };
  const publish = body => call('publish', body);
  const create = (type, document, createIntentId = crypto.randomUUID()) => publish({ operation: 'create', type, document, createIntentId });
  const detail = id => call('documents/[id]', undefined, { id });
  const assertError = (result, status, code) => { assert.equal(result.status, status, JSON.stringify(result)); assert.equal(result.ok, false); assert.equal(result.code, code); assert.equal(result.data, undefined); };
  const scenario = async (name, run) => {
    if (selected !== 'all' && selected !== name) return;
    const startedAt = new Date().toISOString();
    try { await run(); artifact.scenarios.push({ name, passed: true, startedAt, finishedAt: new Date().toISOString() }); }
    catch (error) { artifact.scenarios.push({ name, passed: false, error: error.stack }); throw error; }
  };
  await scenario('auth-and-pause', async () => {
    globalThis.__rooRateLimitBuckets?.clear();
    let authCase=1;
    for (const [name, module] of Object.entries(modules)) {
      const address=`127.0.1.${authCase++}`;
      const body = module.POST ? {} : undefined;
      assertError(await call(name, body, {}, '', address), 401, 'ADMIN_UNAUTHORIZED');
      assertError(await call(name, body, {}, 'wrong', address), 401, 'ADMIN_UNAUTHORIZED');
      const saved = process.env.REF_ADMIN_KEY; delete process.env.REF_ADMIN_KEY;
      assertError(await call(name, body), 503, 'ADMIN_NOT_CONFIGURED'); process.env.REF_ADMIN_KEY = saved;
    }
    process.env.CMS_WRITES_PAUSED = 'true'; assertError(await create('hero', {}), 423, 'CMS_WRITES_PAUSED');
    delete process.env.CMS_WRITES_PAUSED; assertError(await create('hero', {}), 503, 'CMS_WRITE_CONTROL_INVALID');
    process.env.CMS_WRITES_PAUSED = '0';
  });
  await scenario('create-replay-lost-response-revisions', async () => {
    const intent = crypto.randomUUID(); const body = { operation: 'create', type: 'benchmark', createIntentId: intent, document: { title: 'Initial synthetic' } };
    const first = await publish(body); assert.equal(first.ok, true);
    const replay = await publish(body); assert.equal(replay.data.replayed, true); assert.deepEqual({ ...first.data, replayed: true }, replay.data);
    assertError(await publish({ ...body, document: { title: 'Different same intent' } }), 409, 'CMS_REVISION_CONFLICT');
    const id = first.data.documentId, r1 = first.data.revision;
    const changed = await publish({ operation: 'replace', type: 'benchmark', documentId: id, expectedRevision: r1, document: { title: 'Second synthetic' } }); assert.equal(changed.ok, true);
    for (const operation of ['replace','delete']) {
      const stale = await publish({ operation, type: 'benchmark', documentId: id, expectedRevision: r1, ...(operation === 'replace' ? { document: { title: 'Stale' } } : {}) });
      assertError(stale, 409, 'CMS_REVISION_CONFLICT'); assert.equal(stale.details.currentRevision, changed.data.revision);
    }
    assertError(await publish({operation:'replace',type:'benchmark',documentId:id,document:{title:'Missing loaded revision'}}),409,'CMS_REVISION_CONFLICT');
    const history = await call('documents/[id]/revisions', undefined, { id }); assert.equal(history.data.revisions.length, 1);
    const old = await call('documents/[id]/revisions/[revisionId]', undefined, { id, revisionId: history.data.revisions[0].revisionId }); assert.equal(old.data.document.title, 'Initial synthetic'); assert.deepEqual(old.data.assets, {});
    assertError(await call('documents/[id]/revisions/[revisionId]', undefined, { id: 'other', revisionId: history.data.revisions[0].revisionId }), 404, 'CMS_NOT_FOUND');
    const deleted = await publish({ operation: 'delete', type: 'benchmark', documentId: id, expectedRevision: changed.data.revision }); assert.equal(deleted.ok, true);
    assert.equal((await publish(body)).data.replayed, true, 'Lost original create response still replays after deletion');
    assert.equal((await fixture.sql`select count(*)::int n from migration.cms_publish_commands where status='committed'`)[0].n, 3);
  });
  await scenario('singletons-references-booking-identity', async () => {
    const a = await create('hero', { headingLine1: 'Synthetic hero' }); assert.equal(a.ok, true);
    assertError(await create('hero', { headingLine1: 'Another singleton' }), 409, 'CMS_SINGLETON_EXISTS');
    assertError(await publish({ operation: 'delete', type: 'hero', documentId: a.data.documentId, expectedRevision: a.data.revision }), 400, 'CMS_VALIDATION_FAILED');
    const booking = await create('bookingSettings', { maxDaysAheadBooking: 7, dateSlots: [{ _key: 'date', date: '2099-01-05', times: ['10', '11'] }] }); assert.equal(booking.data.documentId, '6d8a3646-0ed2-44b5-ad45-c5c9d578126a');
    const { getBookingSettings } = await import('../src/server/booking/slotPolicy.js'); const settings = await getBookingSettings(); observed('actual fixed-id settings reader', settings); assert.equal(JSON.stringify(settings).includes('2099-01-05'), true);
    const pkg = await create('package', { title: 'Synthetic Reference Package', price: '$12.34', order: 1 }); assert.equal(pkg.ok, true);
    const link = await create('upgradeLink', { title: 'Synthetic upgrade', slug: { _type: 'slug', current: 'synthetic' }, targetPackage: { _type: 'reference', _ref: pkg.data.documentId } }); assert.equal(link.ok, true);
    assertError(await publish({ operation: 'delete', type: 'package', documentId: pkg.data.documentId, expectedRevision: pkg.data.revision }), 409, 'CMS_REFERENCED');
    assertError(await create('upgradeLink', { title: 'Missing reference', slug: { current: 'missing' }, targetPackage: { _type: 'reference', _ref: 'missing-package' } }), 400, 'CMS_VALIDATION_FAILED');
  });
  await scenario('atomic-singleton-reference-and-namespaces', async () => {
    const singleton = await Promise.all([create('contact', { title: 'Contact A' }), create('contact', { title: 'Contact B' })]);
    assert.equal(singleton.filter(row => row.ok).length, 1); assertError(singleton.find(row => !row.ok), 409, 'CMS_SINGLETON_EXISTS');
    const coupons = await Promise.all([create('coupon',{title:'Namespace A',code:'CaseAtomic',discountType:'percent',discountPercent:10}),create('coupon',{title:'Namespace B',code:'caseatomic',discountType:'percent',discountPercent:10})]);
    assert.equal(coupons.filter(row=>row.ok).length,1); assertError(coupons.find(row=>!row.ok),400,'CMS_VALIDATION_FAILED');
    const referralId=crypto.randomUUID();
    const referral=await fixture.client.rpc('roo_apply_document_mutations',{p_mutations:[{operation:'create',document:{_id:referralId,_type:'referral',name:'Synthetic referral namespace',slug:{_type:'slug',current:'ReferralCase'}}}]});assert.equal(referral.error,null);
    assertError(await create('coupon',{title:'Referral collision',code:'referralcase',discountType:'percent',discountPercent:10}),400,'CMS_VALIDATION_FAILED');
    const packages=await Promise.all([create('package',{title:'Atomic Package',price:'$12.34',order:1}),create('package',{title:'atomic package (Upgrade)',price:'$12.34',order:1})]);
    assert.equal(packages.filter(row=>row.ok).length,1);assertError(packages.find(row=>!row.ok),400,'CMS_VALIDATION_FAILED');
    const xoc=await create('package',{title:'Performance Vertex Max',price:'$12.34',order:1});assert.equal(xoc.ok,true);
    assertError(await create('package',{title:'XOC / Extreme Overclocking',price:'$12.34',order:1}),400,'CMS_VALIDATION_FAILED');
    const target=await create('package',{title:'Atomic reference target',price:'$12.34',order:1});assert.equal(target.ok,true);
    const race=await Promise.all([create('upgradeLink',{title:'Racing reference',slug:{current:'atomic-race'},targetPackage:{_type:'reference',_ref:target.data.documentId}}),publish({operation:'delete',type:'package',documentId:target.data.documentId,expectedRevision:target.data.revision})]);
    assert.equal(race.filter(row=>row.ok).length,1);
    const remaining=await fixture.sql`select legacy_sanity_id,payload from migration.source_documents where not tombstoned and legacy_sanity_id in (${target.data.documentId},${race[0].data?.documentId||'absent'})`;
    if(race[0].ok){assertError(race[1],409,'CMS_REFERENCED');assert.equal(remaining.length,2);}else{assertError(race[0],400,'CMS_VALIDATION_FAILED');assert.equal(remaining.length,0);}
    observed('native parallel integrity ordering',{singleton:singleton.map(row=>row.status),couponNamespace:coupons.map(row=>row.status),packageNamespace:packages.map(row=>row.status),referenceDelete:race.map(row=>row.status)});
  });
  await scenario('coupon-redemption-and-pricing', async () => {
    const coupon = await create('coupon', { title: 'Synthetic discount', code: 'AdminCase', discountType: 'percent', discountPercent: 10, timesUsed: 999 }); assert.equal(coupon.ok, true);
    const before = await detail(coupon.data.documentId); assert.equal(before.data.document.timesUsed, 0);
    await fixture.sql`update migration.source_documents set payload=payload||'{"timesUsed":2,"activeReservations":1,"redemptionCount":2,"autoDeactivatedByRedemptionId":"redemption-exact","autoDeactivatedAt":"2026-01-01T00:00:00Z"}'::jsonb where legacy_sanity_id=${coupon.data.documentId}`;
    const changed = await publish({ operation: 'replace', type: 'coupon', documentId: coupon.data.documentId, expectedRevision: before.data.revision, document: { ...before.data.document, notes: 'Edited after concurrent counter update', timesUsed: 0, activeReservations: 0, redemptionCount: 0, autoDeactivatedAt: null, autoDeactivatedByRedemptionId: null } }); assert.equal(changed.ok, true);
    const after = await detail(coupon.data.documentId); assert.equal(after.data.document.timesUsed, 2); assert.equal(after.data.document.activeReservations, 1); assert.equal(after.data.document.redemptionCount, 2); assert.equal(after.data.document.autoDeactivatedByRedemptionId, 'redemption-exact');
    const limited = await create('coupon', { title: 'Actual native consumption', code: 'ActualConsume', discountType: 'percent', discountPercent: 10, maxUses: 1, isActive: true }); assert.equal(limited.ok, true);
    const editorR1 = await detail(limited.data.documentId);
    const { createSupabaseDocumentClient } = await import('../src/server/supabase/documentClient.js');
    const couponClient = createSupabaseDocumentClient({ shadowClient: fixture.client, commerceOnly: true, documentTypes: ['coupon', 'couponRedemption'] });
    const { reserveCouponUse, appendCouponConsumption } = await import('../src/server/api/ref/couponReservations.js');
    const reserved = await reserveCouponUse({ client: couponClient, couponCode: 'ActualConsume', ownerId: 'native-owner', bookingId: 'native-booking' });
    const transaction = couponClient.transaction();
    appendCouponConsumption({ transaction, coupon: reserved.coupon, redemption: reserved.redemption, bookingId: 'native-booking', consumedAt: '2026-01-01T00:00:00Z' });
    await transaction.commit();
    const editorR2 = await detail(limited.data.documentId); assert.equal(editorR2.data.document.timesUsed, 1); assert.equal(editorR2.data.document.isActive, false);
    assertError(await publish({ operation: 'replace', type: 'coupon', documentId: limited.data.documentId, expectedRevision: editorR1.data.revision, document: { ...editorR1.data.document, notes: 'Stale editor after consumption' } }), 409, 'CMS_REVISION_CONFLICT');
    const guarded = await publish({ operation: 'replace', type: 'coupon', documentId: limited.data.documentId, expectedRevision: editorR2.data.revision, document: { ...editorR2.data.document, notes: 'Current revision, malicious/stale counters', timesUsed: 0, activeReservations: 99, redemptionCount: 0, autoDeactivatedAt: null, autoDeactivatedByRedemptionId: null, isActive: true } }); assert.equal(guarded.ok, true);
    const preserved = await detail(limited.data.documentId); assert.equal(preserved.data.document.timesUsed, 1); assert.equal(preserved.data.document.activeReservations, 0); assert.equal(preserved.data.document.isActive, false); assert.equal(preserved.data.document.autoDeactivatedByRedemptionId, reserved.redemption._id);
    const repeated = await publish({ operation: 'replace', type: 'coupon', documentId: limited.data.documentId, expectedRevision: editorR2.data.revision, document: { ...editorR2.data.document, notes: 'Current revision, malicious/stale counters', timesUsed: 0, activeReservations: 99, redemptionCount: 0, autoDeactivatedAt: null, autoDeactivatedByRedemptionId: null, isActive: true } }); assert.equal(repeated.data.replayed, true);
    const pkg = await create('package', { title: 'Synthetic Priced Package', price: '$12.34', order: 1 }); assert.equal(pkg.ok, true);
    const edit = await publish({ operation: 'replace', type: 'package', documentId: pkg.data.documentId, expectedRevision: pkg.data.revision, document: { title: 'Synthetic Priced Package', price: '$23.45', order: 1 } }); assert.equal(edit.ok, true);
    const pricing = await import('../src/server/api/ref/pricing.js'); const quote = await pricing.resolveBookingPricing({ packageTitle: 'Synthetic Priced Package' });
    observed('actual pricing module quote', quote); assert.equal(quote.effectiveGrossAmount, 23.45);
  });
  await scenario('validation-unknown-portabletext-effective-content', async () => {
    for (const [type, document] of [['package',{title:'Invalid',price:'0'}],['package',{title:'Invalid',price:'-12'}],['package',{title:'Invalid',price:'word'}],['siteSettings',{siteMode:'other'}],['tool',{title:'Hosted missing',downloadMode:'hosted'}],['coupon',{title:'Fixed',code:'xy',discountType:'fixed',discountAmount:0}],['hero',{newUnknown:'no'}],['hero',{headingLine1:12}],['hero',{image:{_supabaseUrl:'https://fixture.invalid'}}]]) assertError(await create(type,document),400,'CMS_VALIDATION_FAILED');
    for(const [type,document,path] of [
      ['contact',{subtitle:12},'$.subtitle'],['bookingSettings',{ownerEmail:'invalid'},'$.ownerEmail'],['bookingSettings',{dateSlots:[{_key:'invalid',date:'2099-02-31',times:['10']}]},'$.dateSlots[0].date'],
      ['coupon',{title:'Invalid boolean',code:'BoolCase',discountType:'percent',discountPercent:10,isActive:'yes'},'$.isActive'],['coupon',{title:'Invalid date time',code:'DateCase',discountType:'percent',discountPercent:10,validFrom:'yesterday'},'$.validFrom'],
      ['tool',{title:'Invalid URL',downloadMode:'external',downloadUrl:'javascript:alert(1)'},'$.downloadUrl'],['upgradeLink',{title:'Invalid slug',slug:'text',targetPackage:{_ref:'missing'}},'$.slug'],
      ['review',{title:'Invalid image',image:false},'$.image'],['tool',{title:'Invalid file',downloadMode:'hosted',downloadFile:false},'$.downloadFile'],['upgradeLink',{title:'Invalid reference',slug:{current:'bad-ref'},targetPackage:42},'$.targetPackage'],
      ['meetTheTeam',{founder:[]},'$.founder'],['services',{cards:'text'},'$.cards'],['terms',{sections:[{_key:'bad-block',content:[{_key:'block',_type:'block',style:'alien',markDefs:[],children:[]}]}]},'$.sections[0].content[0].style']
    ]){const refused=await create(type,document);assertError(refused,400,'CMS_VALIDATION_FAILED');assert.ok(refused.details.some(error=>error.path===path),JSON.stringify(refused));}
    const h = await create('benchmark',{title:'Unknown preservation'}); assert.equal(h.ok,true);
    await fixture.sql`update migration.source_documents set payload=payload||'{"unknownStored":{"nested":["original"]}}'::jsonb where legacy_sanity_id=${h.data.documentId}`;
    const d = await detail(h.data.documentId);
    assertError(await publish({operation:'replace',type:'benchmark',documentId:h.data.documentId,expectedRevision:d.data.revision,document:{...d.data.document,unknownStored:{nested:['changed']}}}),400,'CMS_VALIDATION_FAILED');
    const replacement=await publish({operation:'replace',type:'benchmark',documentId:h.data.documentId,expectedRevision:d.data.revision,document:{title:'Known edited'}}); assert.equal(replacement.ok,true); assert.deepEqual((await detail(h.data.documentId)).data.document.unknownStored,{nested:['original']});
    const schema = await import('../src/lib/cms/contentSchema.js');
    const content=schema.PORTABLE_TEXT_DEFAULTS.styles.flatMap((style,i)=>[undefined,'bullet','number'].map((listItem,j)=>({_key:`b${i}${j}`,_type:'block',style,...(listItem?{listItem,level:2}:{}),markDefs:[{_key:'link',_type:'link',href:'https://fixture.invalid'}],children:[{_key:'span',_type:'span',text:'Synthetic portable text',marks:[...schema.PORTABLE_TEXT_DEFAULTS.decorators,'link'] }]})));
    const terms=await create('terms',{title:'Synthetic terms',sections:[{_key:'section',heading:'Synthetic unoverridden heading',content}]});assert.equal(terms.ok,true);
    const raw=await detail(terms.data.documentId);assert.deepEqual(raw.data.document.sections[0].content,content);assert.equal(JSON.stringify(raw).includes('_supabaseUrl'),false);
    const response=await publicRoute.GET(new Request(`${fixture.origin}/api/content/terms`),{params:Promise.resolve({resource:'terms'})}); const effective=await response.json(); assert.equal(effective.ok,true); observed('effective policy including existing overrides',effective);assert.equal(effective.data.sections.some(section=>section.heading==='Synthetic unoverridden heading'),true);
    const React=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');const {PortableText}=await import('@portabletext/react');
    const rendered=renderToStaticMarkup(React.createElement(PortableText,{value:effective.data.sections.find(section=>section.heading==='Synthetic unoverridden heading').content}));
    for(const tag of ['<h1','<h6','<blockquote','<ul','<ol','<strong','<em','<code','<a'])assert.equal(rendered.includes(tag),true,tag);
    fs.writeFileSync('test-results/sanity-admin/effective-policy.html',rendered);observed('rendered actual PortableText effective policy',{sha256:hashes(Buffer.from(rendered)).sha256,bytes:Buffer.byteLength(rendered)});
  });
  const issue = async (bytes, kind, mimeType, extra={}, forceStaging=true) => {
    const body={kind,fileName:`synthetic.${kind==='image'?'png':'zip'}`,mimeType,byteSize:bytes.length,...hashes(bytes),...(kind==='image'?{width:1,height:1}:{}),...extra};
    const rows=forceStaging?await fixture.sql`select id,migration_status from cms.assets where legacy_sanity_asset_id like ${kind+'-'+body.sha1+'-%'} and sha256=${body.sha256}`:[];
    try {for(const row of rows)await fixture.sql`update cms.assets set migration_status='copied' where id=${row.id}`;return await call('assets/upload',body);}
    finally {for(const row of rows)await fixture.sql`update cms.assets set migration_status=${row.migration_status} where id=${row.id}`;if(rows.length)observed('Native staging branch selector control','Verified manifest hash match is temporarily absent (copied status) during issuance only, then restored; verifies staging/finalize branches independently of the alreadyExists shortcut.');}
  };
  const put = async (issued, bytes, mimeType) => { const response=await fetch(issued.signedUrl,{method:'PUT',headers:{'Content-Type':mimeType,'x-upsert':'false'},body:bytes});const result=await response.json(); observed('native signed PUT',{status:response.status,result:sanitize(result)});return {status:response.status,result}; };
  const upload = async (bytes,kind,mimeType,extra={}) => { const issued=await issue(bytes,kind,mimeType,extra,false);assert.equal(issued.ok,true);if(issued.data.alreadyExists)return {issued:issued.data,finalized:{ok:true,data:issued.data}};const sent=await put(issued.data,bytes,mimeType);assert.equal(sent.status,200);const finalized=await call('assets/finalize',{uploadId:issued.data.uploadId});return {issued:issued.data,finalized}; };
  await scenario('uploads-happy-replay-shared-immutable', async () => {
    for(const [bytes,kind,mimeType] of [[png,'image','image/png'],[zip,'file','application/zip']]){
      const first=await upload(bytes,kind,mimeType);assert.equal(first.finalized.ok,true,JSON.stringify(first.finalized));assert.equal(first.finalized.data.sha256,hashes(bytes).sha256);
      assert.equal((await call('assets/finalize',{uploadId:first.issued.uploadId})).ok,true);
      const second=await upload(bytes,kind,mimeType);assert.equal(second.finalized.ok,true);assert.equal(second.issued.alreadyExists,true);assert.equal(second.issued.uploadId,null);assert.equal(second.finalized.data.assetId,first.finalized.data.assetId);
      const overwrite=await fixture.client.storage.from(kind==='image'?'site-content-public':'optimization-builds-private').upload(`${kind==='image'?'images':'builds'}/${hashes(bytes).sha1}.${kind==='image'?'png':'zip'}`,Buffer.from('different'),{upsert:false,contentType:mimeType});assert.equal(Number(overwrite.error.statusCode),409);
      if(kind==='image'){
        const shared=[];for(let i=0;i<2;i++){const doc=await create('review',{title:`Shared image ${i}`,image:{_type:'image',asset:first.finalized.data.asset}});assert.equal(doc.ok,true);shared.push(doc.data.documentId);}
        const reusedToken=await put(first.issued,zip,mimeType);assert.equal(reusedToken.status,200,'Completed staging token can recreate isolated staging, never final');
        assert.equal((await call('assets/finalize',{uploadId:first.issued.uploadId})).data.assetId,first.finalized.data.assetId);
        const finalBytes=await fixture.client.storage.from('site-content-public').download(`images/${hashes(bytes).sha1}.png`);assert.equal(hashes(Buffer.from(await finalBytes.data.arrayBuffer())).sha256,hashes(bytes).sha256);
        for(const id of shared)assert.equal((await detail(id)).data.document.image.asset._ref,first.finalized.data.assetId);
      }
      completed.set(kind,first.finalized.data);
    }
    const image=completed.get('image'),file=completed.get('file');
    const tool=await create('tool',{title:'Synthetic hosted tool',downloadMode:'hosted',downloadFile:{_type:'file',asset:file.asset},icon:{_type:'image',asset:image.asset}});assert.equal(tool.ok,true);
    const geometry={_type:'image',asset:image.asset,crop:{_type:'sanity.imageCrop',top:0.1,bottom:0.2,left:0.1,right:0.1},hotspot:{_type:'sanity.imageHotspot',x:0.5,y:0.5,width:0.8,height:0.8}};
    const crop=await create('review',{title:'Crop geometry',image:geometry});assert.equal(crop.ok,true);const cropRaw=await detail(crop.data.documentId);assert.deepEqual(cropRaw.data.document.image,geometry);
    const cropEdit=await publish({operation:'replace',type:'review',documentId:crop.data.documentId,expectedRevision:cropRaw.data.revision,document:{...cropRaw.data.document,title:'Edited title, original crop'}});assert.equal(cropEdit.ok,true);assert.deepEqual((await detail(crop.data.documentId)).data.document.image,geometry);
    const raw=await detail(tool.data.documentId);assert.equal(raw.data.assets[image.assetId].url,image.url);assert.equal(raw.data.assets[file.assetId].url,null);assert.equal(JSON.stringify(raw.data.document).includes('_supabase'),false);
    const response=await publicRoute.GET(new Request(`${fixture.origin}/api/content/tools`),{params:Promise.resolve({resource:'tools'})});const publicData=await response.json();assert.equal(publicData.ok,true);const row=publicData.data.find(x=>x._id===tool.data.documentId);assert.equal(row.fileUrl,`/api/tools/${tool.data.documentId}/download`);assert.equal(row.iconUrl,image.url);
    completed.set('tool',tool.data);
    const list=await call('documents',undefined,{type:'tool'});assert.equal(list.ok,true);assert.equal(list.data.documents.find(row=>row._id===tool.data.documentId).preview.imageUrl,image.url);
  });
  await scenario('upload-image-formats-and-concurrent-finalize',async()=>{
    const {default:sharp}=await import('sharp');
    for(const [format,mimeType] of [['png','image/png'],['jpeg','image/jpeg'],['gif','image/gif'],['webp','image/webp'],['avif','image/avif']]){
      const bytes=await sharp({create:{width:2,height:3,channels:3,background:'#cc2244'}}).toFormat(format).toBuffer();
      const verified=await upload(bytes,'image',mimeType,{width:2,height:3});assert.equal(verified.finalized.ok,true,JSON.stringify(verified.finalized));assert.equal(verified.finalized.data.width,2);assert.equal(verified.finalized.data.height,3);assert.equal(verified.finalized.data.mimeType,mimeType);
    }
    const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="red"/></svg>');
    const verifiedSvg=await upload(svg,'image','image/svg+xml',{width:2,height:3});assert.equal(verifiedSvg.finalized.ok,true);
    const exe=Buffer.alloc(128);exe.write('MZ',0,'ascii');exe.writeUInt32LE(64,60);exe.write('PE\0\0',64,'ascii');exe.writeUInt16LE(0x8664,68);exe.writeUInt16LE(2,86);
    const verifiedExe=await upload(exe,'file','application/octet-stream');assert.equal(verifiedExe.finalized.ok,true);assert.equal(verifiedExe.finalized.data.mimeType,'application/vnd.microsoft.portable-executable');observed('PE fixture limit','Minimal PE signature/COFF header fixture; no executable is run or installer functionality claimed.');
    const parallel=await issue(png,'image','image/png');assert.equal(parallel.ok,true);assert.equal((await put(parallel.data,png,'image/png')).status,200);
    const results=await Promise.all([call('assets/finalize',{uploadId:parallel.data.uploadId}),call('assets/finalize',{uploadId:parallel.data.uploadId})]);assert.equal(results[0].ok,true);assert.equal(results[1].ok,true);assert.deepEqual(results[0].data,results[1].data);
  });
  await scenario('upload-mismatches-and-token-expiry',async()=>{
    for(const [name,declared,actual,kind,mimeType,extra] of [['zip-claimed-image',zip,zip,'image','image/png',{}],['png-claimed-build',png,png,'file','application/zip',{}],['size',png,png,'image','image/png',{byteSize:png.length+1}],['sha1',png,png,'image','image/png',{sha1:'0'.repeat(40)}],['sha256',png,png,'image','image/png',{sha256:'0'.repeat(64)}],['dimensions',png,png,'image','image/png',{width:2,height:1}]]){
      const issued=await issue(declared,kind,mimeType,extra);assert.equal(issued.ok,true);assert.equal((await put(issued.data,actual,mimeType)).status,200);
      const result=await call('assets/finalize',{uploadId:issued.data.uploadId});assertError(result,422,'ASSET_VERIFICATION_FAILED');
      const row=await fixture.sql`select status from cms.uploads where upload_id=${issued.data.uploadId}`;assert.equal(row[0].status,'refused'); const info=await fixture.client.storage.from(issued.data.bucket).info(issued.data.path);assert.equal(Number(info.error.statusCode),404);observed(name,result);
    }
    const expired=await issue(png,'image','image/png');await new Promise(resolve=>setTimeout(resolve,2200));const sent=await put(expired.data,png,'image/png');assert.equal(sent.status,400);assert.match(sent.result.message,/exp|expired/i);
    assertError(await call('assets/finalize',{uploadId:expired.data.uploadId,path:'different'}),400,'CMS_VALIDATION_FAILED');
    assertError(await issue(png,'image','image/png',{byteSize:20*1024*1024+1}),413,'ASSET_TOO_LARGE');
    assertError(await issue(zip,'file','text/html'),415,'ASSET_TYPE_REFUSED');
  });
  await scenario('upload-chunked-final-collision-bounded-recovery',async()=>{
    const issued=await issue(png,'image','image/png');assert.equal(issued.ok,true);
    const oversize=20*1024*1024+1;let remaining=oversize;
    const stream=new ReadableStream({pull(controller){if(!remaining){controller.close();return;}const amount=Math.min(65536,remaining);controller.enqueue(Buffer.alloc(amount,65));remaining-=amount;}});
    const sent=await fetch(issued.data.signedUrl,{method:'PUT',headers:{'Content-Type':'image/png','x-upsert':'false'},body:stream,duplex:'half'});const sendResult=await sent.json();observed('exact chunked20MiB+1',{status:sent.status,result:sendResult,declared:png.length,actual:oversize});
    if(sent.status===200){assertError(await call('assets/finalize',{uploadId:issued.data.uploadId}),413,'ASSET_TOO_LARGE');}else{assert.equal(Number(sendResult.statusCode),413);}
    const staged=await fixture.client.storage.from(issued.data.bucket).info(issued.data.path);assert.equal(Number(staged.error.statusCode),404);
    const collisionBytes=Buffer.concat([png,Buffer.from('constructed immutable final conflict')]);const digest=hashes(collisionBytes);const finalPath=`images/${digest.sha1}.png`;
    const preseed=await fixture.client.storage.from('site-content-public').upload(finalPath,png,{contentType:'image/png',upsert:false});assert.equal(preseed.error,null);
    const collisionIssue=await issue(collisionBytes,'image','image/png');assert.equal(collisionIssue.ok,true);assert.equal((await put(collisionIssue.data,collisionBytes,'image/png')).status,200);
    assertError(await call('assets/finalize',{uploadId:collisionIssue.data.uploadId}),422,'ASSET_VERIFICATION_FAILED');
    const retained=await fixture.client.storage.from('site-content-public').download(finalPath);assert.equal(hashes(Buffer.from(await retained.data.arrayBuffer())).sha256,hashes(png).sha256);
    assert.equal((await fixture.sql`select count(*)::int n from cms.assets where storage_path=${finalPath}`)[0].n,0);
    assert.equal((await fixture.sql`select status from cms.uploads where upload_id=${collisionIssue.data.uploadId}`)[0].status,'refused');
    const malformedBytes=Buffer.concat([png,Buffer.from('malformed immutable object fixture')]);const malformedHash=hashes(malformedBytes);const malformedPath=`images/${malformedHash.sha1}.png`;
    assert.equal((await fixture.client.storage.from('site-content-public').upload(malformedPath,zip,{contentType:'image/png',upsert:false})).error,null);
    const malformedIssue=await issue(malformedBytes,'image','image/png');assert.equal((await put(malformedIssue.data,malformedBytes,'image/png')).status,200);
    assertError(await call('assets/finalize',{uploadId:malformedIssue.data.uploadId}),422,'ASSET_VERIFICATION_FAILED');
    assert.equal((await fixture.sql`select status from cms.uploads where upload_id=${malformedIssue.data.uploadId}`)[0].status,'refused');
    assert.equal(hashes(Buffer.from(await (await fixture.client.storage.from('site-content-public').download(malformedPath)).data.arrayBuffer())).sha256,hashes(zip).sha256);
    const registryBytes=Buffer.concat([png,Buffer.from('constructed verified registry identity conflict')]);const registry=await upload(registryBytes,'image','image/png');assert.equal(registry.finalized.ok,true);
    await fixture.sql`update cms.assets set sha256=${'0'.repeat(64)} where legacy_sanity_asset_id=${registry.finalized.data.assetId}`;
    const registryIssue=await issue(registryBytes,'image','image/png');assert.equal((await put(registryIssue.data,registryBytes,'image/png')).status,200);
    assertError(await call('assets/finalize',{uploadId:registryIssue.data.uploadId}),422,'ASSET_VERIFICATION_FAILED');
    assert.equal((await fixture.sql`select status from cms.uploads where upload_id=${registryIssue.data.uploadId}`)[0].status,'refused');
    assert.equal((await fixture.sql`select sha256 from cms.assets where legacy_sanity_asset_id=${registry.finalized.data.assetId}`)[0].sha256,'0'.repeat(64));
    const { handleCmsRequest }=await import('../src/server/cms/http.js');const {finalizeCmsUpload}=await import('../src/server/cms/assets.js');
    for(const mode of ['headers','body']){
      const bounded=await issue(png,'image','image/png');assert.equal(bounded.ok,true);assert.equal((await put(bounded.data,png,'image/png')).status,200);
      const nativeFetch=globalThis.fetch;
      globalThis.fetch=async(input,init)=>{
        const url=String(typeof input==='string'||input instanceof URL?input:input.url);
        const response=await nativeFetch(input,init);
        if(!url.includes(`/object/cms-upload-staging/${bounded.data.path}`))return response;
        if(mode==='headers')return new Promise((resolve,reject)=>{const abort=()=>{void response.body?.cancel().catch(()=>{});reject(new DOMException('Held native headers aborted','AbortError'));};if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true});});
        void response.body?.cancel().catch(()=>{});return new Response(new ReadableStream({cancel(){}}),{status:response.status,headers:response.headers});
      };
      const started=Date.now();let response;
      try{response=await handleCmsRequest(new Request(`${fixture.origin}/held-finalize`,{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':'synthetic-admin-key'},body:JSON.stringify({uploadId:bounded.data.uploadId})}),{},({body,client,env,signal})=>finalizeCmsUpload({body,client,env,signal}),{write:true,timeoutMs:150});}finally{globalThis.fetch=nativeFetch;}
      assert.equal(response.status,503);assert.ok(Date.now()-started<5000);const state=await fixture.sql`select status,attempt_count from cms.uploads where upload_id=${bounded.data.uploadId}`;assert.equal(state[0].status,'issued');assert.equal(state[0].attempt_count,1);
      assert.equal((await fixture.client.storage.from(bounded.data.bucket).info(bounded.data.path)).error,null);
      const recovered=await call('assets/finalize',{uploadId:bounded.data.uploadId});assert.equal(recovered.ok,true);
      observed(`held native ${mode} and recovery`,{deadlineMs:150,elapsedMs:Date.now()-started,fault:'After actual official Storage download, transport withholds header delivery or body bytes. Actual SDK and application deadline path execute.'});
    }
    const missing=await issue(png,'image','image/png');
    for(let count=1;count<=6;count++){assert.equal((await call('assets/finalize',{uploadId:missing.data.uploadId})).status,503);const row=await fixture.sql`select status,attempt_count from cms.uploads where upload_id=${missing.data.uploadId}`;assert.equal(row[0].attempt_count,count);assert.equal(row[0].status,count===6?'refused':'issued');}
    assertError(await call('assets/finalize',{uploadId:missing.data.uploadId}),422,'ASSET_VERIFICATION_FAILED');
  });
  await scenario('expired-staging-cleanup-progress',async()=>{
    const ids=[];
    for(let i=0;i<21;i++){
      const uploadId=crypto.randomUUID();ids.push(uploadId);
      const created=await fixture.client.rpc('roo_create_cms_upload',{p_upload:{uploadId,kind:'image',actor:'admin:key',fileName:`expired-${i}.png`,mimeType:'image/png',byteSize:png.length,...hashes(png),width:1,height:1,expiresAt:new Date(Date.now()+3600000).toISOString()}});assert.equal(created.error,null);
      assert.equal((await fixture.client.storage.from('cms-upload-staging').upload(`uploads/${uploadId}`,png,{contentType:'image/png',upsert:false})).error,null);
    }
    await fixture.sql`update cms.uploads set expires_at=now()-interval '2 days' where upload_id=any(${ids}::uuid[])`;
    assert.equal((await issue(png,'image','image/png')).ok,true);
    assert.equal((await fixture.sql`select count(*)::int n from cms.uploads where upload_id=any(${ids}::uuid[]) and staging_cleaned_at is not null`)[0].n,20);
    assert.equal((await issue(png,'image','image/png')).ok,true);
    assert.equal((await fixture.sql`select count(*)::int n from cms.uploads where upload_id=any(${ids}::uuid[]) and staging_cleaned_at is not null`)[0].n,21);
    assert.equal((await fixture.sql`select count(*)::int n from cms.uploads where upload_id=any(${ids}::uuid[])`)[0].n,21);
    assert.equal((await fixture.sql`select count(*)::int n from storage.objects where bucket_id='cms-upload-staging' and name=any(${ids.map(id=>'uploads/'+id)}::text[])`)[0].n,0);
    observed('cleanup exact21 oldest retained rows',{firstBatch:20,secondBatch:1,durableRows:21,expiredObjects:0,fixture:'Synthetic two-day-old durable rows; real official Storage objects deleted through authenticated API, records retained.'});
  });
  await scenario('unverified-assets-tools-fresh-redirect',async()=>{
    assertError(await create('review',{title:'Unverified',image:{_type:'image',asset:{_type:'reference',_ref:'image-'+'0'.repeat(40)+'-1x1-png'}}}),400,'CMS_VALIDATION_FAILED');
    const file=(await upload(zip,'file','application/zip')).finalized.data;
    const tool=await create('tool',{title:'Click-time tool',downloadMode:'hosted',downloadFile:{_type:'file',asset:file.asset}});assert.equal(tool.ok,true);
    const request=new Request(`${fixture.origin}/api/tools/${tool.data.documentId}/download`);
    const guardedFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=>{
      const url=String(typeof input==='string'||input instanceof URL?input:input.url);
      if(url.includes('/object/sign/optimization-builds-private/'))init={...init,body:JSON.stringify({...JSON.parse(init.body),expiresIn:1})};
      return guardedFetch(input,init);
    };
    let first;
    try{first=await tools.GET(request,{params:Promise.resolve({id:tool.data.documentId})});}finally{globalThis.fetch=guardedFetch;}
    assert.equal(first.status,302);assert.match(first.headers.get('Cache-Control'),/private, no-store/);
    const old=JSON.parse(Buffer.from(new URL(first.headers.get('Location')).searchParams.get('token').split('.')[1],'base64url').toString());
    await new Promise(resolve=>setTimeout(resolve,2200));
    const expired=await fetch(first.headers.get('Location'));assert.equal(expired.status,400);
    const second=await tools.GET(request,{params:Promise.resolve({id:tool.data.documentId})});assert.equal(second.status,302);
    const newer=JSON.parse(Buffer.from(new URL(second.headers.get('Location')).searchParams.get('token').split('.')[1],'base64url').toString());
    const fresh=await fetch(second.headers.get('Location'));assert.equal(fresh.status,200);assert.equal(hashes(Buffer.from(await fresh.arrayBuffer())).sha256,hashes(zip).sha256);
    observed('click-time fresh Storage signing', {oldExp:old.exp,newExp:newer.exp,oldStatus:expired.status,freshStatus:fresh.status,fixture:'Short TTL fixture: first actual Storage signing request expiresIn is reduced from900s to1s by transport injection; real token is expired before subsequent normal900s click signing. Equivalent expiry ordering, not15min wall time.'});
    assert.ok(newer.exp>old.exp);
    const replaced=await publish({operation:'replace',type:'tool',documentId:tool.data.documentId,expectedRevision:tool.data.revision,document:{title:'Now external',downloadMode:'external',downloadUrl:'https://fixture.invalid/download'}});assert.equal(replaced.ok,true);
    assert.equal((await tools.GET(request,{params:Promise.resolve({id:tool.data.documentId})})).status,404);
    assert.equal((await publish({operation:'delete',type:'tool',documentId:tool.data.documentId,expectedRevision:replaced.data.revision})).ok,true);
    assert.equal((await tools.GET(request,{params:Promise.resolve({id:tool.data.documentId})})).status,404);
  });
  await scenario('BH7-social-links-and-asset-context',async()=>{
    const social={_key:'social-proof',label:'Synthetic profile',url:'https://example.com/roo-founder',icon:'x'};
    const created=await create('meetTheTeam',{founder:{socialLinks:[social]}});assert.equal(created.ok,true,JSON.stringify(created));
    const stored=await detail(created.data.documentId);assert.equal(stored.data.document.founder.socialLinks[0].url,social.url);
    const read=async()=>{const response=await publicRoute.GET(new Request(`${fixture.origin}/api/content/team`),{params:Promise.resolve({resource:'team'})});assert.equal(response.status,200);return response.json();};
    assert.equal((await read()).data.founder.socialLinks[0].url,social.url);
    const ref='image-'+'0'.repeat(40)+'-3x2-jpg', vendor='https://cdn.sanity.io/images/retained/history/image.jpg';
    await fixture.sql`update migration.source_documents set payload=payload||${fixture.sql.json({founder:{socialLinks:[social,{_key:'vendor',label:'Blocked vendor',url:vendor}],avatar:{_type:'image',asset:{_type:'reference',_ref:ref},url:'https://example.com/unverified-avatar.jpg'}}})} where legacy_sanity_id=${created.data.documentId}`;
    const {clearSupabasePublicContentCache}=await import('../src/server/content/publicContent.js');clearSupabasePublicContentCache();
    const controls=await read();assert.equal(controls.data.founder.socialLinks[0].url,social.url);assert.equal(controls.data.founder.socialLinks[1].url,null);assert.equal(controls.data.founder.avatar.url,null);assert.equal(controls.data.founder.avatar.asset._supabaseUrl,undefined);assert.equal(JSON.stringify(controls).includes('cdn.sanity.io'),false);
    observed('BH7 exact public team roundtrip',{stored:social.url,public:social.url,vendorUrlSuppressed:true,unverifiedAssetSuppressed:true,importedControl:'Locally seeded historical invalid asset; publish correctly refuses unverified refs.'});
  });
  await scenario('BH1-exif-oriented-dimensions',async()=>{
    const {default:sharp}=await import('sharp');
    const base=()=>sharp({create:{width:3,height:2,channels:3,background:'#ff6600'}}).jpeg();
    for(const [name,bytes,width,height]of [['orientation6',await base().withMetadata({orientation:6}).toBuffer(),2,3],['unrotated',await base().toBuffer(),3,2]]){
      const result=await upload(bytes,'image','image/jpeg',{width,height});assert.equal(result.finalized.ok,true,JSON.stringify(result.finalized));const asset=result.finalized.data,expected=`image-${hashes(bytes).sha1}-${width}x${height}-jpg`;assert.equal(asset.assetId,expected);assert.equal(asset.width,width);assert.equal(asset.height,height);
      const row=(await fixture.sql`select width,height,sha256 from cms.assets where legacy_sanity_asset_id=${expected}`)[0];assert.deepEqual(row,{width,height,sha256:hashes(bytes).sha256});const source=(await fixture.sql`select payload from migration.source_documents where legacy_sanity_id=${expected}`)[0].payload;assert.deepEqual(source.metadata.dimensions,{width,height,aspectRatio:width/height});
      const final=await fixture.client.storage.from('site-content-public').download(`images/${hashes(bytes).sha1}.jpg`);assert.equal(final.error,null);assert.equal(hashes(Buffer.from(await final.data.arrayBuffer())).sha256,hashes(bytes).sha256);
      const review=await create('review',{title:name,image:{_type:'image',asset:asset.asset}});assert.equal(review.ok,true);const {enrichSupabaseContentAssets}=await import('../src/server/supabase/assets.js');const enriched=await enrichSupabaseContentAssets({data:(await detail(review.data.documentId)).data.document,client:fixture.client});assert.deepEqual(enriched.image.dimensions,{width,height,aspectRatio:width/height});observed('BH1 '+name,{assetId:expected,width,height,sha256:row.sha256,untransformedBytes:true});
    }
    const wrong=await upload(await base().withMetadata({orientation:6}).toBuffer(),'image','image/jpeg',{width:1,height:3});assertError(wrong.finalized,422,'ASSET_VERIFICATION_FAILED');assert.equal((await fixture.sql`select status from cms.uploads where upload_id=${wrong.issued.uploadId}`)[0].status,'refused');assert.equal(Number((await fixture.client.storage.from(wrong.issued.bucket).info(wrong.issued.path)).error.statusCode),404);
  });
  await scenario('BH3-upgrade-slug-contract-and-namespace',async()=>{
    const pkg=await create('package',{title:'Synthetic slug target',price:'$12.34',order:1});assert.equal(pkg.ok,true);
    const link=slug=>({title:'Synthetic '+slug,slug:{_type:'slug',current:slug},targetPackage:{_type:'reference',_ref:pkg.data.documentId}});
    const invalid=await create('upgradeLink',link('valid_slug'));assertError(invalid,400,'CMS_VALIDATION_FAILED');assert.ok(invalid.details.some(row=>row.path==='$.slug'));
    const first=await create('upgradeLink',link('Valid-Slug'));assert.equal(first.ok,true);const publicRead=async slug=>{const response=await publicRoute.GET(new Request(`${fixture.origin}/api/content/upgrade-link?slug=${encodeURIComponent(slug)}`),{params:Promise.resolve({resource:'upgrade-link'})});assert.equal(response.status,200);return response.json();};assert.equal((await publicRead('valid-slug')).data.title,'Synthetic Valid-Slug');
    const duplicate=await create('upgradeLink',link('VALID-slug'));assertError(duplicate,400,'CMS_VALIDATION_FAILED');assert.ok(duplicate.details.some(row=>row.path==='$.slug'));
    const parallel=await Promise.all([create('upgradeLink',link('Concurrent-Slug')),create('upgradeLink',link('CONCURRENT-slug'))]);assert.equal(parallel.filter(row=>row.ok).length,1);assertError(parallel.find(row=>!row.ok),400,'CMS_VALIDATION_FAILED');
    const legacy=await create('upgradeLink',link('XOClawnmower'));assert.equal(legacy.ok,true);const current=await detail(legacy.data.documentId);const edited=await publish({operation:'replace',type:'upgradeLink',documentId:legacy.data.documentId,expectedRevision:current.data.revision,document:{...current.data.document,title:'Legacy mixed-case remains editable'}});assert.equal(edited.ok,true);assert.equal((await publicRead('xoclawnmower')).data.title,'Legacy mixed-case remains editable');
    process.env.NODE_ENV='test';process.env.UPGRADE_INTENT_TOKEN_SECRET='synthetic-fixround-upgrade-secret';process.env.RATE_LIMIT_HASH_SECRET='synthetic-fixround-rate-secret';const bookingId=crypto.randomUUID();const saved=await fixture.client.rpc('roo_apply_document_mutations',{p_mutations:[{operation:'create',document:{_id:bookingId,_type:'booking',status:'captured',email:'slug@fixture.invalid',packageTitle:'Synthetic original package',packagePrice:'$1.00',grossAmount:1,netAmount:1}}]});assert.equal(saved.error,null);
    const {default:getUpgradeInfo}=await import('../src/server/api/ref/getUpgradeInfo.js');const response={statusCode:200,headers:{},setHeader(key,value){this.headers[key]=value;},status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};await getUpgradeInfo({method:'POST',headers:{'x-forwarded-for':'127.0.0.1'},body:{id:bookingId,email:'slug@fixture.invalid',slug:'XOClawnmower'}},response);assert.equal(response.statusCode,200,JSON.stringify(response.body));assert.equal(response.body.upgradeLink.title,'Legacy mixed-case remains editable');assert.equal(response.body.targetPackage.title,'Synthetic slug target');observed('BH3 exact public and upgrade-info roundtrip',{invalidField:invalid.details,duplicateField:duplicate.details,parallelSuccessCount:1,legacyStoredSlug:(await detail(legacy.data.documentId)).data.document.slug.current,upgradeInfo:response.body.upgradeLink});
  });
  await scenario('R10-admin-key-attempts-and-R12-region',async()=>{
    const saved=process.env.NODE_ENV;process.env.NODE_ENV='development';process.env.RATE_LIMIT_HASH_SECRET='synthetic-fix2-rate-secret';const proofs=[];
    try {let index=1;for(const [name,module]of Object.entries(modules)){assert.equal(module.preferredRegion,'dub1');const address=`10.9.0.${index++}`,body=module.POST?{}:undefined;for(let attempt=1;attempt<=6;attempt++){const result=await call(name,body,{},'wrong-key',address);assertError(result,attempt<=5?401:429,attempt<=5?'ADMIN_UNAUTHORIZED':'ADMIN_RATE_LIMITED');}const valid=await call('documents',undefined,{type:'tool'},'synthetic-admin-key',address);assert.equal(valid.status,200);proofs.push({name,wrongAttempts:6,statuses:[401,401,401,401,401,429],validAfterLimit:200});}assert.equal(tools.preferredRegion,'dub1');const actual=fixture.requestLog.filter(row=>row.rpc==='roo_consume_rate_limit');assert.ok(actual.length>=42);observed('R10 durable wrong-key bound and R12 region',{proofs,nativeRateLimitCalls:actual.length,region:'dub1'});}finally{if(saved===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=saved;}
  });
  await scenario('R9-hosted-tool-without-file-keeps-fallback',async()=>{
    const id='tool.legacy-no-file',fallback='https://example.com/legacy-tool';const saved=await fixture.client.rpc('roo_apply_document_mutations',{p_mutations:[{operation:'create',document:{_id:id,_type:'tool',title:'Legacy no attached file',downloadMode:'hosted',downloadUrl:fallback}}]});assert.equal(saved.error,null);const {clearSupabasePublicContentCache}=await import('../src/server/content/publicContent.js');clearSupabasePublicContentCache();const response=await publicRoute.GET(new Request(`${fixture.origin}/api/content/tools`),{params:Promise.resolve({resource:'tools'})});assert.equal(response.status,200);const row=(await response.json()).data.find(row=>row._id===id);assert.equal(row.fileUrl,null);assert.equal(row.downloadUrl,fallback);const {stableToolDownloadLinks}=await import('../src/server/cms/toolDownload.js');assert.equal(stableToolDownloadLinks([{_id:'attached',downloadMode:'hosted',downloadFile:{asset:{_ref:'file-fixture-zip'}}}])[0].fileUrl,'/api/tools/attached/download');observed('R9 actual public legacy fallback',row);
  });
  await scenario('R13-publish-missing-createdAt',async()=>{
    const id='hero-r13';const seeded=await fixture.client.rpc('roo_apply_document_mutations',{p_mutations:[{operation:'create',document:{_id:id,_type:'hero',headingLine1:'Before'}}]});assert.equal(seeded.error,null);await fixture.sql`update migration.source_documents set payload=payload-'_createdAt' where legacy_sanity_id=${id}`;const [current]=await fixture.sql`select source_revision,payload from migration.source_documents where legacy_sanity_id=${id}`;assert.equal(Object.hasOwn(current.payload,'_createdAt'),false);const hash=hashes(Buffer.from('R13-reviewer-exact-probe')).sha256;const replaced=await fixture.client.rpc('roo_apply_cms_publish_command',{p_command_id:'cms:'+hash,p_request_hash:hash,p_actor:'admin:key',p_mutations:[{operation:'replace',id,expected_revision:current.source_revision,document:{_id:id,_type:'hero',headingLine1:'After'}}],p_assets:[],p_asset_links:[]});assert.equal(replaced.error,null);const [after]=await fixture.sql`select payload from migration.source_documents where legacy_sanity_id=${id}`;assert.notEqual(after.payload._createdAt,null);assert.equal(after.payload.headingLine1,'After');const swap=await fixture.client.rpc('roo_apply_cms_publish_command',{p_command_id:'cms:'+hash+'swap',p_request_hash:hash,p_actor:'admin:key',p_mutations:[{operation:'replace',id,expected_revision:after.payload._rev,document:{_id:id,_type:'package',title:'Swapped Package',price:'$10'}}],p_assets:[],p_asset_links:[]});assert.equal(swap.error.code,'22023');assert.equal((await fixture.sql`select document_type from migration.source_documents where legacy_sanity_id=${id}`)[0].document_type,'hero');observed('R13 exact hero probe',{createdAt:after.payload._createdAt,typeSwapRefused:true});
  });
  await scenario('supabase-only-image-paths-and-missing-sidecar',async()=>{
    const source=await create('benchmark',{title:'Imported unmatched image'});assert.equal(source.ok,true);
    const ref='image-'+'f'.repeat(40)+'-1x1-png';const rawImage={_type:'image',asset:{_type:'reference',_ref:ref},url:'https://cdn.sanity.io/images/retained/history/image.png'};
    await fixture.sql`update migration.source_documents set payload=payload||${fixture.sql.json({beforeImage:rawImage})} where legacy_sanity_id=${source.data.documentId}`;
    const raw=await detail(source.data.documentId);assert.deepEqual(raw.data.document.beforeImage,rawImage);assert.deepEqual(raw.data.assets[ref],{url:null,width:null,height:null,mimeType:null,byteSize:null});
    const {enrichSupabaseContentAssets}=await import('../src/server/supabase/assets.js');const {urlFor}=await import('../src/lib/cmsImageUrl.js');
    const enriched=await enrichSupabaseContentAssets({data:raw.data.document,client:fixture.client});assert.equal(enriched.beforeImage.url,null);assert.equal(enriched.beforeImage.asset._supabaseUrl,undefined);
    assert.equal(urlFor(enriched.beforeImage).url(),null);assert.equal(urlFor('https://cdn.sanity.io/images/retained/history/image.png').url(),null);assert.equal(urlFor('/images/local-fixture.png').url(),'/images/local-fixture.png');
    const external=await enrichSupabaseContentAssets({data:{downloadUrl:'https://fixture.invalid/external-download',officialSite:'https://fixture.invalid'},client:fixture.client});assert.equal(external.downloadUrl,'https://fixture.invalid/external-download');assert.equal(external.officialSite,'https://fixture.invalid');
    const publicResponse=await publicRoute.GET(new Request(`${fixture.origin}/api/content/benchmarks`),{params:Promise.resolve({resource:'benchmarks'})});const publicData=await publicResponse.json();assert.equal(publicData.ok,true);assert.equal(JSON.stringify(publicData).includes('cdn.sanity.io'),false);
    assertError(await publish({operation:'replace',type:'benchmark',documentId:source.data.documentId,expectedRevision:raw.data.revision,document:{...raw.data.document,beforeImage:{...rawImage,asset:{...rawImage.asset,_supabaseInternal:'forged'}}}}),400,'CMS_VALIDATION_FAILED');
    observed('D4 imported raw shape limit','Synthetic imported raw source inserted locally; editor retains it unchanged, sidecar covers missing ref, actual enrichment/URL builder/public API emit no vendor URL. No image downloaded from any outside host.');
  });
  await scenario('public-content-join-limit', async () => {
    const documents = [
      { _id: '0-fixture-package', _type: 'package', title: 'Fixture Join Package', price: '$12.34', order: 1 },
      { _id: 'z-fixture-games', _type: 'supportedGames', title: 'Fixture Supported Games', featuredGames: [
        { _key: 'game-one', title: 'Fixture Game One' },
        { _key: 'game-two', title: 'Fixture Game Two' },
      ] },
      { _id: 'join-limit-upgrade', _type: 'upgradeLink', title: 'Fixture Upgrade', slug: { _type: 'slug', current: 'fixture-join-limit' }, targetPackage: { _type: 'reference', _ref: '0-fixture-package' } },
      { _id: '0-fixture-team', _type: 'meetTheTeam', heroTitle: 'Fixture Team' },
      { _id: '0-fixture-about', _type: 'about', recordTitle: 'Fixture About' },
    ];
    const seeded = await fixture.client.rpc('roo_apply_document_mutations', { p_mutations: documents.map(document => ({ operation: 'create', document })) });
    assert.equal(seeded.error, null);
    const live = await fixture.sql`select legacy_sanity_id, document_type from migration.source_documents where not tombstoned and legacy_sanity_id in ('0-fixture-package', 'z-fixture-games') order by legacy_sanity_id`;
    assert.deepEqual(live.map(row => row.legacy_sanity_id), ['0-fixture-package', 'z-fixture-games']);
    observed('public-content-join-limit live source order', live);
    const { fetchPublicContent, clearSupabasePublicContentCache } = await import('../src/server/content/publicContent.js');
    clearSupabasePublicContentCache();
    fixture.setRequestHook((phase, request) => {
      if (phase === 'after' && request.path === '/rest/v1/rpc/roo_fetch_shadow_documents_targeted') {
        observed('public-content-join-limit native read', { status: request.status, documentTypes: request.body.p_document_types, limit: request.body.p_limit, ids: Array.isArray(request.response) ? request.response.map(document => document._id) : null });
      }
    });
    try {
      const games = await fetchPublicContent({ resource: 'supported-games', searchParams: new URLSearchParams() });
      observed('public-content-join-limit supported-games', games);
      const upgrade = await fetchPublicContent({ resource: 'upgrade-link', searchParams: new URLSearchParams({ slug: 'fixture-join-limit' }) });
      const team = await fetchPublicContent({ resource: 'team', searchParams: new URLSearchParams() });
      const about = await fetchPublicContent({ resource: 'about', searchParams: new URLSearchParams() });
      assert.equal(upgrade.title, 'Fixture Upgrade');
      assert.deepEqual(upgrade.targetPackage, { title: 'Fixture Join Package', price: '$12.34' });
      assert.equal(team.heroTitle, 'Fixture Team');
      assert.equal(about.recordTitle, 'Fixture About');
      observed('public-content-join-limit controls', { upgrade, team, about, passed: true });
      assert.notEqual(games, null, 'A package sorting first must not hide supportedGames from the public join query');
      assert.equal(games.title, 'Fixture Supported Games');
      assert.equal(games.featuredGames.length, 2);
      assert.deepEqual(games.featuredGames.map(game => game.title), ['Fixture Game One', 'Fixture Game Two']);
      const response = await publicRoute.GET(new Request(`${fixture.origin}/api/content/supported-games`), { params: Promise.resolve({ resource: 'supported-games' }) });
      const result = await response.json();
      assert.equal(response.status, 200);
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, games);
      observed('public-content-join-limit public API', { status: response.status, result });
    } finally {
      fixture.setRequestHook(null);
    }
  });
  if(!artifact.scenarios.length)throw new Error(`Unknown scenario ${selected}`);
  artifact.requests=fixture.requestLog.map(({method,path,rpc})=>({method,path,rpc}));
  artifact.sanityRequests=artifact.requests.filter(row=>/sanity\.io|sanity\.studio/.test(row.path));assert.equal(artifact.sanityRequests.length,0);
  artifact.passed=true;
}catch(error){artifact.error=error.stack;process.exitCode=1;}
finally{
  if(fixture)artifact.cleanup=await fixture.stop();
  artifact.finishedAt=new Date().toISOString();fs.mkdirSync('test-results/sanity-admin',{recursive:true});fs.writeFileSync(`test-results/sanity-admin/${selected}.json`,JSON.stringify(sanitize(artifact),null,2)+'\n');
  console.log(JSON.stringify({passed:artifact.passed,scenarios:artifact.scenarios.map(row=>({name:row.name,passed:row.passed})),error:artifact.error,artifact:`test-results/sanity-admin/${selected}.json`}));
}
