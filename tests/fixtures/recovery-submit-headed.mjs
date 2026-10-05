const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { installNetworkGuard, guardBrowserContext, localOrigin, refuseEnvFiles } from '../../scripts/lib/test-target-safety.mjs';

refuseEnvFiles();
if (process.env.DISPLAY !== ':0') throw new Error('Headed Linux DISPLAY=:0 is required.');
const args = new Map(process.argv.slice(2).map(value => value.split('=')));
const scenario = args.get('--scenario') || 'recovery-submit';
const phase = args.get('--phase') || 'after';
const fixture = args.get('--fixture') || 'finish';
if (!/^[a-z0-9-]+$/.test(scenario) || !['before', 'after'].includes(phase) || !['finish', 'repairs'].includes(fixture)) throw new Error('Invalid named scenario.');
const port = Number(process.env.UI_PORT || 45983);
const nextPort = Number(process.env.UI_NEXT_PORT || 45982);
if (![port, nextPort].every(value => Number.isInteger(value) && value > 1024 && value < 65536) || port === nextPort) throw new Error('Invalid local fixture ports.');
const origins = [port, nextPort].map(value => localOrigin(`http://${testHost}:${value}`));
installNetworkGuard(origins);
const { chromium } = await import('@playwright/test');
const binary = fs.existsSync(chromium.executablePath()) ? chromium.executablePath() : '/opt/google/chrome/chrome';
const binaryVersion = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
const artifactBase = path.resolve(`test-results/recovery-submit-headed-${phase}-${fixture}-${scenario}`);
fs.mkdirSync(path.dirname(artifactBase), { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'roo-recovery-submit-chromium-'));
const screenshots = [];
const blocked = [];
const requests = [];
let context;
let evidence;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: binary, headless: false, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', args: ['--ozone-platform=x11', '--disable-dev-shm-usage'] });
  await guardBrowserContext(context, origins);
  context.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  context.on('requestfailed', request => { if (!origins.includes(new URL(request.url()).origin)) blocked.push({ url: request.url(), error: request.failure()?.errorText }); });
  const page = context.pages()[0] || await context.newPage();
  await page.exposeFunction('__captureUiRecoveryCheckpoint', async (name, currentPhase) => {
    if (!/^[a-z0-9-]+$/.test(name) || currentPhase !== phase) throw new Error('Invalid screenshot checkpoint.');
    const file = `${artifactBase}-${name}.png`;
    await page.screenshot({ path: file }); screenshots.push(file);
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `${origins[0]}/__ui/${fixture}?scenario=${scenario}&phase=${phase}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__uiFinishComplete || window.__uiRepairsComplete, null, { timeout: 240000 });
  const result = await page.evaluate(() => ({ browser: { userAgent: navigator.userAgent, platform: navigator.platform, visibility: document.visibilityState, hidden: document.hidden }, results: window.__uiFinishResults || window.__uiRepairsResults }));
  if (!result.browser.platform.startsWith('Linux')) throw new Error('A Linux browser is required.');
  if (!Array.isArray(result.results) || !result.results.length) throw new Error('No named cases completed.');
  evidence = { scenario, phase, fixture, complete: true, node: process.version, binary, binaryVersion, origins, url, profile, ...result, errors, blocked, requests, screenshots, cleanup: { browserClosed: false, profileRemoved: false } };
  fs.writeFileSync(`${artifactBase}.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ artifact: `${artifactBase}.json`, browser: result.browser, results: result.results.map(row => ({ name: row.name, ok: row.ok, error: row.error, errorMs: row.errorMs, cReadyMs: row.cReadyMs, artifact: row.artifact })), screenshots }));
  if (phase === 'after' && result.results.some(row => !row.ok)) process.exitCode = 1;
} finally {
  await context?.close();
  fs.rmSync(profile, { recursive: true, force: true });
  if (evidence) { evidence.cleanup = { browserClosed: true, profileRemoved: !fs.existsSync(profile) }; fs.writeFileSync(`${artifactBase}.json`, JSON.stringify(evidence, null, 2)); }
}
