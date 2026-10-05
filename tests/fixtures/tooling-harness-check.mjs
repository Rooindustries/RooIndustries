import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { guardBrowserContext, localOrigin } from '../../scripts/lib/test-target-safety.mjs';

const origin = localOrigin(process.env.BASE_URL);
const target = new URL(origin);
const scenarios = [];
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Local static asset guard</title><main><h1>Owned fixture</h1><img alt="Synthetic logo" src="https://razorpay.com/assets/razorpay-logo.svg"></main>');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(target.port), target.hostname, resolve); });
let browser;
const check = async (name, action) => {
  try { scenarios.push({ name, passed: true, proof: await action() }); }
  catch (error) { scenarios.push({ name, passed: false, error: String(error.message) }); }
};
try {
  await check('explicit-empty-target-refuses-before-endpoint-io', async () => {
    const before = requests;
    const env = { PATH: process.env.PATH, BASE_URL: '', ROO_TEST_HOST: process.env.ROO_TEST_HOST, TOOLING_NETWORK_GUARD: '1' };
    const result = spawnSync(process.execPath, ['--test', 'tests/agent-readiness.test.mjs'], { env, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /BASE_URL is required/);
    assert.equal(requests, before);
    const inherited = spawnSync(process.execPath, ['--input-type=module', '-e', 'console.log(JSON.stringify({base:process.env.BASE_URL,imports:process.env.NODE_OPTIONS,origins:JSON.parse(process.env.ROO_TEST_NETWORK_ORIGINS)}))'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(inherited.status, 0, inherited.stderr);
    const state = JSON.parse(inherited.stdout);
    assert.equal(state.base, ''); assert.match(state.imports, /test-target-safety\.mjs/); assert.deepEqual(state.origins, [origin]);
    return { status: result.status, endpointRequests: requests - before, inherited: state };
  });
  browser = await chromium.launch({ headless: false, args: ['--ozone-platform=x11'] });
  await check('known-product-static-asset-fulfilled-before-network', async () => {
    const context = await browser.newContext();
    try {
      const guard = await guardBrowserContext(context, [origin]);
      const page = await context.newPage();
      const replies = [];
      page.on('response', response => { if (response.url() === 'https://razorpay.com/assets/razorpay-logo.svg') replies.push({ url: response.url(), status: response.status() }); });
      await page.goto(origin, { waitUntil: 'networkidle' });
      assert.deepEqual(replies, [{ url: 'https://razorpay.com/assets/razorpay-logo.svg', status: 200 }]);
      assert.equal(await page.locator('img').evaluate(node => node.complete && node.naturalWidth > 0), true);
      assert.equal(guard.staticAssets.length, 1); assert.equal(guard.unexpectedRequests.length, 0);
      return { replies, guard, headed: true, browserVersion: browser.version(), serverRequests: requests };
    } finally { await context.close(); }
  });
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  const output = process.env.TOOLING_HARNESS_ARTIFACT || 'test-results/fix-h/harness-check.json';
  fs.writeFileSync(output, JSON.stringify({ scenarios, passed: scenarios.filter(row => row.passed).length, total: scenarios.length }, null, 2) + '\n');
  console.log(JSON.stringify({ output, passed: scenarios.filter(row => row.passed).length, total: scenarios.length }));
}
if (scenarios.some(row => !row.passed)) process.exitCode = 1;
