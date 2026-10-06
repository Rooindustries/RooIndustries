import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { start } from './lib/storage-fixture.mjs';
import { seedContentAdmin, CONTENT_ADMIN_EMAIL, CONTENT_ADMIN_PASSWORD } from './lib/content-admin-fixture.mjs';

const root = path.resolve('.');
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) specifier = pathToFileURL(path.join(root, specifier.slice(2))).href;
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('.') || specifier.startsWith('file:')) && !path.extname(specifier)) return next(specifier + '.js', context);
    throw error;
  }
} });

const selected = process.argv.find(arg => arg.startsWith('--scenario='))?.slice(11) || 'all';
const shotsLabel = process.argv.find(arg => arg.startsWith('--shots='))?.slice(8) || 'current';
const hold = process.argv.includes('--hold');
const outDir = 'test-results/sanity-ui';
const host = process.env.ADMIN_UI_HOST || '127.0.0.1';
const adminKey = 'synthetic-admin-key';
const distDir = '.next-e2e-admin-content';
const artifact = { selected, startedAt: new Date().toISOString(), transport: 'Real Next dev server (app router, middleware, CSP headers) on a headed Chromium (DISPLAY=:0) against PostgreSQL 17 + official PostgREST + official Storage v1.79.33 with the full migration chain. The gateway is a Kong stand-in; no GoTrue.', scenarios: [], browserRequests: { blocked: [], sanity: [] }, consoleErrors: [], passed: false };
fs.mkdirSync(outDir, { recursive: true });
for (const file of fs.readdirSync(outDir)) if (/^failed-.*\.png$/.test(file)) fs.rmSync(path.join(outDir, file));
const redact = text => String(text).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted-jwt]').replace(/([?&]token=)[^&\s'"]+/g, '$1[redacted]');
const write = () => fs.writeFileSync(path.join(outDir, `${selected}.json`), JSON.stringify(artifact, null, 2) + '\n');

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  server.on('error', reject);
});

let fixture;
let nextProcess;
let browser;
const cleanup = {};
try {
  for (const key of Object.keys(process.env)) if (/(^|_)SANITY_/.test(key)) delete process.env[key];
  fixture = await start({ fullMigrationChain: true, signedUploadExpirationSeconds: 600 });
  artifact.versions = fixture.versions;
  const expectedFiles = fs.readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort();
  assert.deepEqual(fixture.manifest.map(row => path.basename(row.file)).sort(), expectedFiles, 'Full migration chain required');
  const env = {
    REF_ADMIN_KEY: adminKey, REF_SESSION_SECRET:'synthetic-content-session-secret', CMS_WRITES_PAUSED: '0', RATE_LIMIT_HASH_SECRET: 'synthetic-rate-limit',
    SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_URL: fixture.origin, NEXT_PUBLIC_SUPABASE_ASSET_URL: fixture.origin,
    SUPABASE_SERVICE_ROLE_KEY: fixture.token, SUPABASE_SECRET_KEY: fixture.token, NEXT_PUBLIC_SUPABASE_ANON_KEY: fixture.anonKey,
    DATA_PRIMARY_BACKEND: 'supabase', COMMERCE_PRIMARY_BACKEND: 'supabase', COMMERCE_FAILOVER_GENERATION: '1',
    SUPABASE_CUTOVER_ENABLED: '1', COMMERCE_CUTOVER_ENABLED: '1',
  };
  Object.assign(process.env, env);
  await fixture.sql`update migration.commerce_control set generation = 1 where singleton`;

  await seedContentAdmin(fixture);
  const modules = {};
  for (const name of ['documents', 'documents/[id]', 'publish']) modules[name] = await import(`../app/api/admin/content/${name}/route.js`);
  const call = async (name, body, params = {}) => {
    const method = body === undefined ? 'GET' : 'POST';
    const request = new Request(`${fixture.origin}/api/admin/content/${name}${params.type ? '?type=' + encodeURIComponent(params.type) : ''}`, { method, headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await modules[name][method](request, { params: Promise.resolve(params) });
    return { status: response.status, ...(await response.json()) };
  };
  const create = async (type, document) => {
    const result = await call('publish', { operation: 'create', type, createIntentId: crypto.randomUUID(), document });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data.documentId;
  };
  const detail = async id => {
    const result = await call('documents/[id]', undefined, { id });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const listIds = async type => (await call('documents', undefined, { type })).data.documents.map(entry => entry._id);

  const block = (key, spans) => ({ _type: 'block', _key: key, style: 'normal', markDefs: [], children: spans.map(([text, marks = []], index) => ({ _type: 'span', _key: `${key}s${index}`, text, marks })) });
  const ids = {};
  ids.hero = await create('hero', { tagline: 'Seed tagline', headingLine1: 'Seed heading', ctaPrimaryText: 'Book now', bullets: ['Alpha', 'Bravo', 'Charlie'] });
  ids.terms = await create('terms', { title: 'Seed terms', lastUpdated: 'October 2026', sections: [
    { _key: 'sec1', _type: 'object', heading: 'Seed payments', content: [block('b1', [['Pay before the session starts.']]), block('b2', [['Refunds are ', []], ['never automatic', ['strong']], ['.', []]])] },
    { _key: 'sec2', _type: 'object', heading: 'Seed cancellations', content: [block('b3', [['Cancel up to 24 hours ahead.']]), block('b4', [['Line ending\n']]), block('b5', [['Hello'], [' world']])] },
  ] });
  ids.package = await create('package', { title: 'Seed Package', price: '$49.00', order: 1, description: 'Seed description' });
  ids.faq = await create('faqSection', { questions: [
    { _key: 'q1', _type: 'object', question: 'Seed question one?', answer: 'One.' },
    { _key: 'q2', _type: 'object', question: 'Seed question two?', answer: 'Two.' },
    { _key: 'q3', _type: 'object', question: 'Seed question three?', answer: 'Three.' },
  ] });
  artifact.seed = ids;

  const nextPort = await freePort();
  const nextOrigin = `http://${host}:${nextPort}`;
  artifact.nextOrigin = nextOrigin;
  const log = fs.openSync(path.join(outDir, 'next-dev.log'), 'w');
  nextProcess = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-H', host, '-p', String(nextPort)], {
    cwd: root, stdio: ['ignore', log, log],
    env: { ...process.env, NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development', ROO_TEST_HOST: host },
  });
  fs.closeSync(log);
  cleanup.nextPid = nextProcess.pid;
  for (let attempt = 0; ; attempt++) {
    assert.equal(nextProcess.exitCode, null, fs.readFileSync(path.join(outDir, 'next-dev.log'), 'utf8').slice(-4000));
    if (/Ready in|ready started|Local:/.test(fs.readFileSync(path.join(outDir, 'next-dev.log'), 'utf8'))) break;
    if (attempt > 600) throw new Error('Next dev server readiness deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  browser = await chromium.launch({ headless: false, ...(process.env.ADMIN_UI_CHROMIUM_PATH ? {executablePath:process.env.ADMIN_UI_CHROMIUM_PATH} : {}), args: ['--ozone-platform=x11', '--gtk-version=3', '--disable-gpu'], handleSIGINT: !hold, handleSIGTERM: !hold });
  const allowed = new Set([nextOrigin, fixture.origin]);
  let contextAddress=1;
  const guard = async context => {
    const address='127.0.90.'+(contextAddress++);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (allowed.has(url.origin) && !url.username) return route.continue({headers:{...await route.request().allHeaders(),'x-forwarded-for':address}});
      const entry = { url: `${url.origin}${url.pathname}`, method: route.request().method() };
      if (/(^|\.)(sanity\.io|sanity\.studio)$/i.test(url.hostname)) artifact.browserRequests.sanity.push(entry);
      else artifact.browserRequests.blocked.push(entry);
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket(url => !allowed.has(new URL(url).origin.replace(/^ws/, 'http')), socket => socket.close());
  };
  const watch = page => {
    page.on('dialog', dialog => dialog.accept());
    page.on('pageerror', error => artifact.consoleErrors.push({ type: 'pageerror', text: redact(error.message).slice(0, 400) }));
    page.on('console', message => {
      if (message.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/.test(message.text())) artifact.consoleErrors.push({ type: 'console', text: redact(message.text()).slice(0, 400) });
    });
  };

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await guard(context);
  const page = await context.newPage();
  watch(page);
  const shot = name => page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
  const unlock = async (target = page) => {
    await target.goto(`${nextOrigin}/admin/content`, { timeout: 240000, waitUntil: 'load' });
    const state=await target.evaluate(()=>fetch('/api/admin/content/session',{cache:'no-store'}).then(response=>response.json()));
    if(state.data?.signedIn!==true) {await target.getByLabel('Email',{exact:true}).fill(CONTENT_ADMIN_EMAIL);await target.getByLabel('Password',{exact:true}).fill(CONTENT_ADMIN_PASSWORD);await target.getByRole('button',{name:'Sign in',exact:true}).click();}
    await target.getByRole('navigation', { name: 'Content types' }).waitFor({ timeout: 60000 });
  };
  const openType = async (title, target = page) => {
    await target.getByRole('navigation', { name: 'Content types' }).getByRole('button', { name: title, exact: true }).click();
  };
  const publishAndWait = async (target = page) => {
    await target.getByRole('button', { name: 'Publish', exact: true }).click();
    await target.getByText('Published. The live site', { exact: false }).waitFor({ timeout: 60000 });
  };
  const scenario = async (name, run, { explicitOnly = false } = {}) => {
    if (selected !== name && (selected !== 'all' || explicitOnly)) return;
    const startedAt = new Date().toISOString();
    try { await run(); artifact.scenarios.push({ name, passed: true, startedAt, finishedAt: new Date().toISOString() }); }
    catch (error) { artifact.scenarios.push({ name, passed: false, error: error.stack }); await shot(`failed-${name}`).catch(() => {}); throw error; }
    finally { write(); }
  };

  await scenario('gate-and-noindex', async () => {
    await page.goto(`${nextOrigin}/admin/content`, { timeout: 240000, waitUntil: 'load' });
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    assert.match(robots, /noindex/);
    for(let i=0;i<8;i++){await page.reload();await page.getByLabel('Email',{exact:true}).waitFor();assert.deepEqual((await page.getByRole('alert').allTextContents()).map(text=>text.trim()).filter(Boolean),[]);}artifact.signedOutProbeReloads=8;
    await page.getByLabel('Email',{exact:true}).fill(CONTENT_ADMIN_EMAIL);
    await page.getByLabel('Password',{exact:true}).fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Email or password was not accepted.').waitFor();
    await shot('desktop-gate');
    await page.getByLabel('Password',{exact:true}).fill(CONTENT_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('navigation', { name: 'Content types' }).waitFor({ timeout: 60000 });
    await shot('desktop-workspace');
  });

  await scenario('hero-string-and-primitive-array', async () => {
    if (selected !== 'all') await unlock();
    await openType('Hero Section');
    const before = (await detail(ids.hero)).document;
    const field = page.getByLabel(/^Primary CTA Text/);
    await field.fill('Book a session');
    await page.getByRole('button', { name: 'Move up' }).nth(2).click();
    assert.equal(await page.getByRole('button', { name: 'Delete' }).count(), 0, 'Singletons have no delete');
    await shot('desktop-hero-editor');
    await publishAndWait();
    const after = (await detail(ids.hero)).document;
    assert.equal(after.ctaPrimaryText, 'Book a session');
    assert.deepEqual(after.bullets, ['Alpha', 'Charlie', 'Bravo']);
    assert.equal(after.tagline, before.tagline);
    assert.equal(after._id, before._id);
  });

  await scenario('terms-portable-text-bold-lossless', async () => {
    if (selected !== 'all') await unlock();
    await openType('Terms and Conditions');
    const before = (await detail(ids.terms)).document;
    await page.getByRole('button', { name: 'Seed payments' }).click();
    const editable = page.getByRole('textbox', { name: /paragraph 1$/ }).first();
    await editable.waitFor();
    await editable.evaluate(element => {
      const text = element.firstChild;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 3);
      element.focus();
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.getByRole('button', { name: 'Bold', exact: true }).first().click();
    await shot('desktop-terms-pt');
    await publishAndWait();
    const after = (await detail(ids.terms)).document;
    const [sectionBefore, otherBefore] = before.sections;
    const [sectionAfter, otherAfter] = after.sections;
    assert.equal(sectionAfter._key, 'sec1');
    const edited = sectionAfter.content[0];
    assert.equal(edited._key, 'b1');
    assert.deepEqual(edited.children.map(span => [span.text, span.marks]), [['Pay', ['strong']], [' before the session starts.', []]]);
    assert.deepEqual(sectionAfter.content[1], sectionBefore.content[1], 'Unedited block is byte-identical');
    assert.deepEqual(otherAfter, otherBefore, 'Unedited section is byte-identical');
    assert.equal(after.title, before.title);
  });

  await scenario('faq-object-array-reorder', async () => {
    if (selected !== 'all') await unlock();
    await openType('FAQ');
    await page.getByRole('region', { name: 'FAQ list' }).locator('[class*="documentList"] button').first().click();
    await page.getByRole('button', { name: 'Seed question one?' }).waitFor();
    await page.getByRole('button', { name: 'Move down' }).first().click();
    await publishAndWait();
    const after = (await detail(ids.faq)).document;
    assert.deepEqual(after.questions.map(entry => entry._key), ['q2', 'q1', 'q3']);
  });

  await scenario('coupon-create-with-reference', async () => {
    if (selected !== 'all') await unlock();
    const beforeIds = await listIds('coupon');
    await openType('Coupons');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByLabel(/^Coupon Name/).fill('Browser coupon');
    await page.getByLabel(/^Coupon Code/).fill('BROWSER15');
    await page.getByLabel(/^Discount Percentage/).fill('15');
    await page.getByRole('button', { name: 'Add item' }).first().click();
    const select = page.getByLabel(/^Eligible Packages/).last();
    await select.selectOption({ label: 'Seed Package' });
    await shot('desktop-coupon-new');
    await publishAndWait();
    const created = (await listIds('coupon')).filter(id => !beforeIds.includes(id));
    assert.equal(created.length, 1);
    const coupon = (await detail(created[0])).document;
    assert.equal(coupon.code, 'BROWSER15');
    assert.equal(coupon.discountPercent, 15);
    assert.equal(coupon.eligiblePackages.length, 1);
    assert.equal(coupon.eligiblePackages[0]._ref, ids.package);
    assert.match(coupon.eligiblePackages[0]._key, /^[a-f0-9]{12}$/);
    ids.coupon = created[0];
  });

  await scenario('review-image-upload', async () => {
    if (selected !== 'all') await unlock();
    const image = await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 34, g: 211, b: 238, alpha: 1 } } }).png().toBuffer();
    const file = path.join(outDir, 'upload-fixture.png');
    fs.writeFileSync(file, image);
    const sha1 = crypto.createHash('sha1').update(image).digest('hex');
    const beforeIds = await listIds('review');
    await openType('Reviews');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByLabel(/^Title/).first().fill('Browser review');
    await page.locator('input[type="file"]').first().setInputFiles(file);
    await page.getByText('64×48').waitFor({ timeout: 60000 });
    await shot('desktop-review-upload');
    await publishAndWait();
    const created = (await listIds('review')).filter(id => !beforeIds.includes(id));
    assert.equal(created.length, 1);
    const review = await detail(created[0]);
    assert.equal(review.document.image.asset._ref, `image-${sha1}-64x48-png`);
    assert.ok(review.assets[`image-${sha1}-64x48-png`]?.url, 'Verified public URL for the uploaded image');
    const rows = await fixture.sql`select migration_status, storage_path from cms.assets where legacy_sanity_asset_id = ${`image-${sha1}-64x48-png`}`;
    assert.deepEqual(rows.map(row => ({ ...row })), [{ migration_status: 'verified', storage_path: `images/${sha1}.png` }]);
    artifact.uploadedAsset = `image-${sha1}-64x48-png`;
  });

  await scenario('conflict-then-restore-draft', async () => {
    if (selected !== 'all') await unlock();
    await openType('Packages');
    await page.getByRole('region', { name: 'Packages list' }).getByRole('button', { name: /Seed Package/ }).click();
    await page.getByRole('heading', { name: 'Seed Package', exact: true }).waitFor({ timeout: 30000 });
    const loaded = await detail(ids.package);
    const other = await call('publish', { operation: 'replace', type: 'package', documentId: ids.package, expectedRevision: loaded.revision, document: { ...loaded.document, title: 'Seed Package (other editor)' } });
    assert.equal(other.ok, true, JSON.stringify(other));
    await page.getByLabel(/^Short Description/).fill('Edited in the browser');
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.getByText('Someone published a newer version while you were editing.').waitFor({ timeout: 30000 });
    await shot('desktop-conflict');
    const stillOther = (await detail(ids.package)).document;
    assert.equal(stillOther.title, 'Seed Package (other editor)');
    assert.equal(stillOther.description, 'Seed description');
    await page.getByRole('button', { name: 'Load latest version' }).click();
    await page.getByText(/Unpublished changes from .* are saved on this device/).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Restore my changes' }).click();
    assert.equal(await page.getByLabel(/^Short Description/).inputValue(), 'Edited in the browser');
    await publishAndWait();
    const final = (await detail(ids.package)).document;
    assert.equal(final.description, 'Edited in the browser');
  });

  await scenario('history-restore', async () => {
    if (selected !== 'all') await unlock();
    await openType('Hero Section');
    await page.getByRole('button', { name: 'History' }).click();
    const entries = page.getByRole('complementary', { name: 'Version history' }).getByRole('listitem');
    await entries.first().waitFor({ timeout: 30000 });
    await shot('desktop-history');
    await entries.last().getByRole('button', { name: 'Load this version' }).click();
    await page.getByText(/Loaded the version that was live before/).waitFor();
    await publishAndWait();
    const after = (await detail(ids.hero)).document;
    assert.equal(after.ctaPrimaryText, 'Book now');
    assert.deepEqual(after.bullets, ['Alpha', 'Bravo', 'Charlie']);
  });

  await scenario('draft-survives-refresh', async () => {
    if (selected !== 'all') await unlock();
    await openType('Hero Section');
    await page.getByLabel(/^Tagline/).fill('Unsaved tagline');
    await page.waitForTimeout(900);
    artifact.draftKeysBeforeReload = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('roo-content-draft:')));
    await page.reload({ waitUntil: 'load' });
    await page.getByRole('navigation',{name:'Content types'}).waitFor({timeout:60000});
    await openType('Hero Section');
    await page.getByText(/Unpublished changes from .* are saved on this device/).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Restore my changes' }).click();
    assert.equal(await page.getByLabel(/^Tagline/).inputValue(), 'Unsaved tagline');
    const stored = (await detail(ids.hero)).document;
    assert.equal(stored.tagline, 'Seed tagline', 'Nothing published without the Publish button');
    await page.getByRole('button', { name: 'Discard them' }).count();
  });

  await scenario('pt-trailing-break-blur-and-shift-enter', async () => {
    if (selected !== 'all') await unlock();
    await openType('Terms and Conditions');
    const before = (await detail(ids.terms)).document;
    await page.getByRole('button', { name: 'Seed cancellations' }).click();
    const paragraphs = page.getByRole('textbox', { name: /paragraph \d+$/ });
    await paragraphs.nth(1).click();
    await paragraphs.nth(2).click();
    await page.getByLabel(/^Main Title/).click();
    assert.equal(await page.getByText('Unpublished changes', { exact: true }).count(), 0, 'Focus and blur without typing must not change the document');
    await paragraphs.nth(0).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Second line');
    await page.keyboard.press('Shift+Enter');
    await publishAndWait();
    const after = (await detail(ids.terms)).document;
    const [b3, b4, b5] = after.sections[1].content;
    assert.equal(b3._key, 'b3');
    assert.equal(b3.children.map(span => span.text).join(''), 'Cancel up to 24 hours ahead.\nSecond line\n');
    assert.deepEqual(b4, before.sections[1].content[1], 'Trailing line break block untouched');
    assert.deepEqual(b5, before.sections[1].content[2], 'Two-span block untouched');
    assert.deepEqual(after.sections[0], before.sections[0]);
  });

  await scenario('upload-keeps-concurrent-edits', async () => {
    if (selected !== 'all') await unlock();
    const image = await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 200, g: 120, b: 20, alpha: 1 } } }).png().toBuffer();
    const file = path.join(outDir, 'upload-concurrent.png');
    fs.writeFileSync(file, image);
    const sha1 = crypto.createHash('sha1').update(image).digest('hex');
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let finalizeSeen = false;
    await page.route('**/api/admin/content/assets/finalize', async route => { finalizeSeen = true; await held; await route.fallback(); });
    const beforeIds = await listIds('review');
    await openType('Reviews');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByLabel(/^Title/).first().fill('Before');
    await page.locator('input[type="file"]').first().setInputFiles(file);
    await page.getByText('Verifying on the server').waitFor({ timeout: 60000 });
    assert.equal(finalizeSeen, true);
    await page.getByLabel(/^Title/).first().fill('After');
    assert.equal(await page.getByRole('button', { name: 'Uploading…' }).isDisabled(), true, 'Publish waits for the upload');
    release();
    await page.getByText('40×30').waitFor({ timeout: 60000 });
    await page.unroute('**/api/admin/content/assets/finalize');
    assert.equal(await page.getByLabel(/^Title/).first().inputValue(), 'After');
    await publishAndWait();
    const created = (await listIds('review')).filter(id => !beforeIds.includes(id));
    assert.equal(created.length, 1);
    const review = (await detail(created[0])).document;
    assert.equal(review.title, 'After');
    assert.equal(review.image.asset._ref, `image-${sha1}-40x30-png`);
  });

  await scenario('upload-cancel-during-verify', async () => {
    if (selected !== 'all') await unlock();
    const image = await sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 10, g: 220, b: 90, alpha: 1 } } }).png().toBuffer();
    const file = path.join(outDir, 'upload-cancel.png');
    fs.writeFileSync(file, image);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/admin/content/assets/finalize', async route => { await held; await route.fallback().catch(() => {}); });
    await openType('Reviews');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByLabel(/^Title/).first().fill('Cancelled upload');
    await page.locator('input[type="file"]').first().setInputFiles(file);
    await page.getByText('Verifying on the server').waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    release();
    await page.waitForTimeout(1500);
    await page.unroute('**/api/admin/content/assets/finalize');
    assert.equal(await page.getByText('20×10').count(), 0, 'Cancelled upload is not attached');
    assert.equal(await page.getByText('No image selected.').count(), 1);
  });

  await scenario('svg-viewbox-upload', async () => {
    if (selected !== 'all') await unlock();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#22d3ee"/></svg>');
    const file = path.join(outDir, 'upload-viewbox.svg');
    fs.writeFileSync(file, svg);
    const sha1 = crypto.createHash('sha1').update(svg).digest('hex');
    const beforeIds = await listIds('review');
    await openType('Reviews');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByLabel(/^Title/).first().fill('SVG review');
    await page.locator('input[type="file"]').first().setInputFiles(file);
    await page.getByText('24×24').waitFor({ timeout: 60000 });
    await publishAndWait();
    const created = (await listIds('review')).filter(id => !beforeIds.includes(id));
    assert.equal(created.length, 1);
    assert.equal((await detail(created[0])).document.image.asset._ref, `image-${sha1}-24x24-svg`);
  });

  await scenario('reupload-existing-image-skips-transfer', async () => {
    if (selected !== 'all') await unlock();
    const image = await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 34, g: 211, b: 238, alpha: 1 } } }).png().toBuffer();
    const file = path.join(outDir, 'upload-existing.png');
    fs.writeFileSync(file, image);
    const sha1 = crypto.createHash('sha1').update(image).digest('hex');
    const existing = await fixture.sql`select count(*)::int as n from cms.assets where legacy_sanity_asset_id = ${`image-${sha1}-64x48-png`} and migration_status = 'verified'`;
    if (existing[0].n === 0) {
      await openType('Reviews');
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByLabel(/^Title/).first().fill('First copy');
      await page.locator('input[type="file"]').first().setInputFiles(file);
      await page.getByText('64×48').waitFor({ timeout: 60000 });
      await publishAndWait();
    }
    const puts = [];
    const onRequest = request => { if (request.method() === 'PUT' && request.url().includes('/storage/v1/object/upload/sign/')) puts.push(request.url()); };
    page.on('request', onRequest);
    const beforeIds = await listIds('review');
    await openType('Reviews');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByLabel(/^Title/).first().fill('Same image again');
    await page.locator('input[type="file"]').first().setInputFiles(file);
    await page.getByText('64×48').waitFor({ timeout: 60000 });
    page.off('request', onRequest);
    assert.deepEqual(puts, [], 'Known verified bytes attach without another transfer');
    await publishAndWait();
    const created = (await listIds('review')).filter(id => !beforeIds.includes(id));
    assert.equal(created.length, 1);
    assert.equal((await detail(created[0])).document.image.asset._ref, `image-${sha1}-64x48-png`);
  });

  await scenario('api-outage-keeps-editor-unlocked', async () => {
    if (selected !== 'all') await unlock();
    await page.route('**/api/admin/content/documents?type=benchmark', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Content service is temporarily unavailable.', code: 'CMS_UNAVAILABLE' }) }));
    await openType('Benchmark');
    await page.getByText('Content service is temporarily unavailable.').waitFor({ timeout: 30000 });
    assert.equal(await page.getByLabel('Email',{exact:true}).count(), 0, 'An outage must not lock the editor');
    assert.equal(await page.getByRole('navigation', { name: 'Content types' }).isVisible(), true);
    await page.unroute('**/api/admin/content/documents?type=benchmark');
  });

  await scenario('mobile-panes', async () => {
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await guard(mobile);
    const phone = await mobile.newPage();
    watch(phone);
    await unlock(phone);
    const overflow = () => phone.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
    assert.ok(await overflow() <= 0, 'No horizontal overflow on types pane');
    await phone.screenshot({ path: path.join(outDir, 'mobile-types.png') });
    await openType('Packages', phone);
    await phone.getByRole('region', { name: 'Packages list' }).waitFor();
    assert.equal(await phone.getByRole('navigation', { name: 'Content types' }).isVisible(), false);
    await phone.screenshot({ path: path.join(outDir, 'mobile-documents.png') });
    await phone.getByRole('region', { name: 'Packages list' }).getByRole('button', { name: /Seed Package/ }).click();
    await phone.getByRole('button', { name: 'Publish', exact: true }).waitFor();
    assert.ok(await overflow() <= 0, 'No horizontal overflow on editor pane');
    await phone.screenshot({ path: path.join(outDir, 'mobile-editor.png'), fullPage: true });
    await phone.getByRole('button', { name: /^Packages$/ }).first().click();
    await phone.getByRole('region', { name: 'Packages list' }).waitFor();
    await mobile.close();
  });

  await scenario('theme-screens', async () => {
    const image = await sharp({ create: { width: 480, height: 320, channels: 4, background: { r: 40, g: 60, b: 120, alpha: 1 } } }).png().toBuffer();
    const digest = algorithm => crypto.createHash(algorithm).update(image).digest('hex');
    for (const name of ['assets/upload', 'assets/finalize']) modules[name] = await import(`../app/api/admin/content/${name}/route.js`);
    const issued = await call('assets/upload', { kind: 'image', fileName: 'review.png', mimeType: 'image/png', byteSize: image.length, sha1: digest('sha1'), sha256: digest('sha256'), width: 480, height: 320 });
    assert.equal(issued.ok, true, JSON.stringify(issued));
    let asset = issued.data.asset;
    if (issued.data.uploadId) {
      const put = await fetch(issued.data.signedUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png', 'x-upsert': 'false' }, body: image });
      assert.equal(put.ok, true, `signed PUT ${put.status}`);
      const finalized = await call('assets/finalize', { uploadId: issued.data.uploadId });
      assert.equal(finalized.ok, true, JSON.stringify(finalized));
      asset = finalized.data.asset;
    }
    for (let index = 1; index <= 139; index++) {
      await create('review', index % 7 === 0 ? { title: `Synthetic review ${index}` } : { title: `Synthetic review ${index} with a longer headline to test truncation`, image: { _type: 'image', asset }, alt: `Review ${index}` });
    }
    const shotsDir = path.join(outDir, 'theme-pass', shotsLabel);
    fs.mkdirSync(shotsDir, { recursive: true });
    const viewports = { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };
    const shots = [];
    for (const theme of ['default', 'dark']) {
      for (const [device, viewport] of Object.entries(viewports)) {
        const { width, height, ...rest } = viewport;
        const themed = await browser.newContext({ viewport: { width, height }, ...rest });
        await guard(themed);
        await themed.addInitScript(value => window.localStorage.setItem('roo-theme', value), theme);
        const view = await themed.newPage();
        watch(view);
        const save = async (name, fullPage = false) => {
          const file = path.join(shotsDir, `${theme}-${device}-${name}.png`);
          await view.waitForTimeout(400);
          await view.screenshot({ path: file, fullPage });
          shots.push(path.relative(root, file));
        };
        for (const [name, route] of [['site-home', '/'], ['site-packages', '/packages'], ['site-booking', '/booking'], ['site-referrals-login', '/referrals/login'], ['site-admin-referrals', '/admin/referrals']]) {
          await view.goto(`${nextOrigin}${route}`, { timeout: 240000, waitUntil: 'load' });
          assert.equal(await view.evaluate(() => document.documentElement.dataset.theme), theme);
          await save(name);
        }
        await view.goto(`${nextOrigin}/admin/content`, { timeout: 240000, waitUntil: 'load' });
        await view.getByLabel('Email',{exact:true}).waitFor();
        await save('admin-gate');
        await view.getByLabel('Email',{exact:true}).fill(CONTENT_ADMIN_EMAIL);
        await view.getByLabel('Password',{exact:true}).fill('wrong-password');
        await view.getByRole('button', { name: 'Sign in' }).click();
        await view.getByRole('alert').first().waitFor({ timeout: 30000 }).catch(() => {});
        await save('admin-gate-error');
        await unlock(view);
        await save('admin-start');
        await openType('Hero Section', view);
        await view.getByRole('button', { name: 'Publish', exact: true }).waitFor();
        await save('admin-hero');
        await view.goto(`${nextOrigin}/admin/content`, { waitUntil: 'load' });
        await unlock(view);
        await openType('Reviews', view);
        await view.getByRole('region', { name: 'Reviews list' }).getByRole('button', { name: /Synthetic review 1 / }).waitFor({ timeout: 60000 });
        await save('admin-reviews-list');
        await view.getByRole('region', { name: 'Reviews list' }).getByRole('button', { name: /Synthetic review 2 / }).click();
        await view.getByRole('button', { name: 'Publish', exact: true }).waitFor();
        await view.getByText('480×320').first().waitFor({ timeout: 60000 });
        await save('admin-review-editor');
        await view.goto(`${nextOrigin}/admin/content`, { waitUntil: 'load' });
        await unlock(view);
        await openType('Terms and Conditions', view);
        await view.getByRole('button', { name: 'Seed payments' }).click();
        await view.getByRole('textbox', { name: /paragraph 1$/ }).first().waitFor();
        await save('admin-terms', true);
        await view.goto(`${nextOrigin}/admin/content`, { waitUntil: 'load' });
        await unlock(view);
        await openType('Coupons', view);
        await view.getByRole('button', { name: 'New', exact: true }).click();
        await view.getByRole('button', { name: 'Publish', exact: true }).click();
        await view.waitForTimeout(600);
        await save('admin-coupon-errors', true);
        await view.goto(`${nextOrigin}/admin/content`, { waitUntil: 'load' });
        await unlock(view);
        await openType('Packages', view);
        await view.getByRole('region', { name: 'Packages list' }).getByRole('button', { name: /Seed Package/ }).click();
        await view.getByRole('button', { name: 'History' }).click();
        await view.getByRole('complementary', { name: 'Version history' }).getByText(/No earlier versions|Load this version/).first().waitFor({ timeout: 30000 });
        await save('admin-package-history', true);
        assert.ok(await view.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth) <= 0, `No horizontal overflow (${theme} ${device})`);
        await themed.close();
      }
    }
    artifact.themeScreens = shots;
  }, { explicitOnly: true });

  await scenario('history-restore-confirms-discard', async () => {
    await unlock();
    const before=await detail(ids.hero);assert.equal((await call('publish',{operation:'replace',type:'hero',documentId:ids.hero,expectedRevision:before.revision,document:{...before.document,tagline:'Revision target'}})).ok,true);
    await openType('Hero Section');await page.getByLabel(/^Tagline/).fill('Exact unsaved edit');
    await page.getByRole('button',{name:'History',exact:true}).click();
    const load=page.getByRole('complementary',{name:'Version history'}).getByRole('button',{name:'Load this version'}).first();await load.waitFor();
    const draftStorageKey='roo-content-draft:v1:doc:'+ids.hero,dialogMessages=[];page.removeAllListeners('dialog');let dialogs=0;page.once('dialog',dialog=>{dialogs++;dialogMessages.push(dialog.message());void dialog.dismiss();});await load.click();await page.waitForTimeout(600);
    assert.equal(dialogs,1,'Restore must confirm discarding dirty edits');assert.equal(dialogMessages[0],'Replace your unpublished changes with this version? They will be lost.');assert.equal(await page.getByLabel(/^Tagline/).inputValue(),'Exact unsaved edit');assert.equal(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),draftStorageKey)).document.tagline,'Exact unsaved edit');const actorLabels=await page.getByRole('complementary',{name:'Version history'}).getByRole('listitem').locator('span').allTextContents();assert.ok(actorLabels.every(label=>label==='Admin'),JSON.stringify(actorLabels));
    page.removeAllListeners('dialog');page.once('dialog',dialog=>{dialogMessages.push(dialog.message());void dialog.accept();});await load.click();await page.getByText(/Loaded the version/).waitFor();assert.equal(await page.getByLabel(/^Tagline/).inputValue(),before.document.tagline);await page.waitForFunction(({key,tagline})=>JSON.parse(localStorage.getItem(key)||'null')?.document?.tagline===tagline,{key:draftStorageKey,tagline:before.document.tagline});assert.equal(dialogMessages[1],dialogMessages[0]);artifact.restoreDraft={key:draftStorageKey,restoredTagline:before.document.tagline,dialogMessages,actorLabels};page.on('dialog',dialog=>dialog.accept());await shot('history-restore-confirms-discard');
  });
  await scenario('login-wrong-password-and-signout', async () => {
    await unlock();await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByLabel('Email',{exact:true}).waitFor();
    await page.getByLabel('Email',{exact:true}).fill(CONTENT_ADMIN_EMAIL);await page.getByLabel('Password',{exact:true}).fill('wrong-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByText('Email or password was not accepted.',{exact:true}).waitFor();
    await page.getByLabel('Password',{exact:true}).fill(CONTENT_ADMIN_PASSWORD);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('navigation',{name:'Content types'}).waitFor();
    await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByLabel('Email',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>fetch('/api/admin/content/session',{cache:'no-store'}).then(response=>response.json())),{ok:true,data:{signedIn:false}});await page.reload();await page.getByLabel('Email',{exact:true}).waitFor();await shot('password-signout');
  });
  await scenario('terms-code-owned-banner', async () => {
    await unlock();await openType('Terms and Conditions');await page.getByText('The Payments & refunds and Cancellations sections, the Terms last-updated date and the money-back FAQ answer are managed in code and ignore edits here.',{exact:true}).waitFor();assert.equal(await page.getByRole('navigation',{name:'Content types'}).getByRole('button',{name:'Footer',exact:true}).count(),0);await shot('terms-code-owned-banner');
  });
  await scenario('draft-quota-notice', async () => {
    await unlock();await openType('Hero Section');await page.evaluate(()=>{window.__originalStorageSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('roo-content-draft:'))throw new DOMException('Quota full','QuotaExceededError');return window.__originalStorageSetItem.call(this,key,value);};});
    await page.getByLabel(/^Tagline/).fill('Quota edit continues');await page.getByText('Your draft could not be saved in this browser.',{exact:true}).waitFor();await page.getByLabel(/^Tagline/).fill('Quota edit still continues');assert.equal(await page.getByLabel(/^Tagline/).inputValue(),'Quota edit still continues');const current=await detail(ids.hero);assert.equal((await call('publish',{operation:'replace',type:'hero',documentId:ids.hero,expectedRevision:current.revision,document:{...current.document,tagline:'Concurrent quota version'}})).ok,true);await page.getByRole('button',{name:'Publish',exact:true}).click();await page.getByRole('button',{name:'Load latest version',exact:true}).waitFor();page.removeAllListeners('dialog');let confirmation;page.once('dialog',dialog=>{confirmation=dialog.message();void dialog.dismiss();});await page.getByRole('button',{name:'Load latest version',exact:true}).click();await page.waitForTimeout(300);assert.equal(confirmation,'Your draft could not be saved on this device. Load the latest version and lose your edits?');assert.equal(await page.getByLabel(/^Tagline/).inputValue(),'Quota edit still continues');artifact.quotaConflict={confirmation,dismissKeepsEdit:true};page.on('dialog',dialog=>dialog.accept());await shot('draft-quota-notice');await page.evaluate(()=>{Storage.prototype.setItem=window.__originalStorageSetItem;});
  });
  await scenario('link-rule-agreement', async () => {
    await unlock();await openType('Terms and Conditions');await page.getByRole('button',{name:'Seed payments',exact:true}).click();const editable=page.getByRole('textbox',{name:/paragraph 1$/}).first();await editable.focus();
    page.removeAllListeners('dialog');const messages=[];page.on('dialog',dialog=>{messages.push({type:dialog.type(),message:dialog.message()});void dialog.accept(dialog.type()==='prompt'?'#anchor':undefined);});await page.getByRole('button',{name:'Add link',exact:true}).first().click();await page.waitForTimeout(300);assert.ok(messages.some(message=>message.type==='alert'&&/single \/|HTTP/.test(message.message)));assert.equal(await editable.locator('a').count(),0);page.removeAllListeners('dialog');page.on('dialog',dialog=>dialog.accept());
    await editable.evaluate(element=>{element.focus();const range=document.createRange();range.selectNodeContents(element);range.collapse(false);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);const data=new DataTransfer();data.setData('text/html','<a href="javascript:alert(1)">x</a>');data.setData('text/plain','x');element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));document.execCommand('insertHTML',false,'<a href="javascript:alert(1)">x</a>');element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste'}));});await page.getByLabel(/^Main Title/).focus();const pasteKey='roo-content-draft:v1:doc:'+ids.terms;await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)||'null')?.document?.sections?.[0]?.content?.[0]?.children?.map(span=>span.text).join('').includes('xx'),pasteKey);const pasted=JSON.parse(await page.evaluate(key=>localStorage.getItem(key),pasteKey)).document.sections[0].content[0];assert.ok(!pasted.markDefs.some(mark=>mark.href?.startsWith('javascript:')));assert.ok(pasted.children.filter(span=>span.text.includes('x')).every(span=>!span.marks.some(mark=>pasted.markDefs.some(def=>def._key===mark&&def.href?.startsWith('javascript:')))));artifact.pastedJavascriptLink={dropped:true,markDefs:pasted.markDefs};
    const doc=await detail(ids.terms),section=doc.document.sections[0],content=section.content[0],legacy={...content,markDefs:[{_key:'legacy-link',_type:'link',href:'//host'}],children:content.children.map(span=>({...span,marks:['legacy-link']}))};const next={...doc.document,sections:[{...section,content:[legacy,...section.content.slice(1)]},...doc.document.sections.slice(1)]};
    assert.equal((await fixture.client.rpc('roo_apply_document_mutations',{p_mutations:[{operation:'replace',id:ids.terms,document:next}]})).error,null);await page.reload();await page.getByRole('navigation',{name:'Content types'}).waitFor();await openType('Terms and Conditions');await page.getByLabel(/^Main Title/).fill('Legacy link validation');await page.getByRole('button',{name:'Publish',exact:true}).click();await page.getByText(/Link 1 in Sections.*Content/).waitFor();await shot('link-rule-agreement');
  });
  await scenario('create-intent-load-latest', async () => {
    await unlock();await openType('Benchmark');await page.getByRole('button',{name:'New',exact:true}).click();await page.getByLabel(/^Benchmark Name/).fill('Committed create intent');
    await page.evaluate(()=>{const original=window.fetch;let first=true;window.__createIntentOriginalFetch=original;window.fetch=async(input,init)=>{const response=await original(input,init);if(first&&String(input).endsWith('/api/admin/content/publish')&&init?.method==='POST'){first=false;window.__createIntentHttpStatus=response.status;return new Response(JSON.stringify({ok:false,error:'Synthetic lost response',code:'CMS_UNAVAILABLE'}),{status:503,headers:{'content-type':'application/json'}});}return response;};});
    await page.getByRole('button',{name:'Publish',exact:true}).click();await page.getByText(/Synthetic lost response/).waitFor();await page.getByLabel(/^Benchmark Name/).fill('Changed create intent');await page.getByRole('button',{name:'Publish',exact:true}).click();await page.getByRole('button',{name:'Load latest version',exact:true}).waitFor();await page.getByRole('button',{name:'Load latest version',exact:true}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('input')).some(input=>input.value==='Committed create intent'));assert.equal(await page.getByLabel(/^Benchmark Name/).inputValue(),'Committed create intent');artifact.createIntentLostResponseHttpStatus=await page.evaluate(()=>{window.fetch=window.__createIntentOriginalFetch;return window.__createIntentHttpStatus;});assert.equal(artifact.createIntentLostResponseHttpStatus,200);await shot('create-intent-load-latest');
  });
  await scenario('password-gate-themes', async () => {
    for(const theme of ['default','dark']) {const themed=await browser.newContext({viewport:{width:1440,height:1000}});await guard(themed);await themed.addInitScript(theme=>localStorage.setItem('roo-theme',theme),theme);const view=await themed.newPage();watch(view);await view.goto(nextOrigin+'/admin/content');await view.getByLabel('Email',{exact:true}).waitFor();await view.screenshot({path:path.join(outDir,'password-gate-'+theme+'.png')});await unlock(view);await view.screenshot({path:path.join(outDir,'password-editor-'+theme+'.png')});assert.ok(await view.evaluate(()=>document.scrollingElement.scrollWidth<=window.innerWidth));await themed.close();}
  });
  if (hold) {
    console.log(JSON.stringify({ holding: nextOrigin, fixture: fixture.origin, pid: process.pid }));
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  }

  assert.deepEqual(artifact.browserRequests.sanity, [], 'No browser request may reach Sanity');
  artifact.passed = artifact.scenarios.length > 0 && artifact.scenarios.every(entry => entry.passed);
} finally {
  artifact.finishedAt = new Date().toISOString();
  if (browser) await browser.close().catch(() => {});
  if (nextProcess && nextProcess.exitCode === null) {
    nextProcess.kill('SIGTERM');
    await new Promise(resolve => { const timer = setTimeout(() => { if (nextProcess.exitCode === null) nextProcess.kill('SIGKILL'); resolve(); }, 8000); nextProcess.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
  cleanup.nextExited = !nextProcess || nextProcess.exitCode !== null || nextProcess.signalCode !== null;
  fs.rmSync(path.join(root, distDir), { recursive: true, force: true });
  cleanup.distRemoved = !fs.existsSync(path.join(root, distDir));
  if (fixture) cleanup.fixture = await fixture.stop();
  artifact.cleanup = cleanup;
  write();
}
console.log(JSON.stringify({ passed: artifact.passed, scenarios: artifact.scenarios.map(({ name, passed }) => ({ name, passed })), blocked: artifact.browserRequests.blocked.length, sanity: artifact.browserRequests.sanity.length, consoleErrors: artifact.consoleErrors.length }, null, 2));
process.exit(artifact.passed ? 0 : 1);
