const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localOrigin, refuseEnvFiles } from './lib/test-target-safety.mjs';

refuseEnvFiles();
const origin = localOrigin(process.env.BASE_URL || `http://${testHost}:45981`);
const results = [];
const request = async pathname => {
  const response = await fetch(`${origin}${pathname}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  assert.match(response.headers.get('content-security-policy') || '', /connect-src 'self'/);
  return response;
};
const redirect = await request('/discord');
assert.equal(redirect.status, 503);
assert.equal(redirect.headers.get('location'), null);
results.push({ name: 'external-redirect-refused', status: redirect.status, followed: false });
const entry = await request('/index.html');
assert.equal(entry.status, 200);
const entryHtml = await entry.text();
assert.equal(entryHtml.includes('%PUBLIC_URL%'), false);
assert.equal(entryHtml.includes('api.sanity.io'), false);
for (const asset of ['/favicon.ico', '/fonts/roboto-flex-latin-opsz-normal.woff2']) assert.equal((await request(asset)).status, 200);
results.push({ name: 'static-entry-assets-served', status: entry.status });
const guide = await request('/BIOSGuide/index.html');
assert.equal(guide.status, 200);
const guideHtml = await guide.text();
for (const incorrect of ['Move the jumper from pins 1-2 to pins 2-3', 'It will automatically recover.', 'XMP/EXPO is NOT Risky Overclocking', '"Auto" does nothing.', "You'll boot with default settings", 'zero risk', 'up to 95°C safely']) assert.equal(guideHtml.includes(incorrect), false, incorrect);
for (const reference of ['https://www.asus.com/us/support/faq/1040820/', 'https://www.amd.com/en/legal/claims/gaming-details.html', '89°C']) assert.ok(guideHtml.includes(reference));
results.push({ name: 'bios-repeated-guarantees-removed', status: guide.status, referencesFollowed: false });
for (const name of ['manifest.json', 'site.webmanifest']) {
  const response = await request(`/${name}`); assert.equal(response.status, 200);
  const manifest = await response.json();
  for (const icon of manifest.icons) { assert.ok(icon.src.startsWith('/') && !icon.src.startsWith('//')); assert.equal((await request(icon.src)).status, 200); }
  results.push({ name: `manifest-icons-served-${name}`, count: manifest.icons.length });
}
const evidence = { ok: true, origin, results, standIns: 'Isolated proxy refuses all backend mutation paths. Actual Next dev server and actual static assets. No live provider, database or transaction proof claimed.' };
const output = path.resolve('test-results/ui-sweep-http-final.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, checks: results.length, output }));
