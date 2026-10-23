import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(done => setTimeout(done, ms));
const stop = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(done => child.once('close', done));
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
  await closed;
  clearTimeout(force);
};

if (process.argv[2] !== '--sandbox') {
  const scratchBase = process.env.TMPDIR || join(root, 'test-results');
  await mkdir(scratchBase, { recursive: true });
  const scratch = await mkdtemp(join(scratchBase, 'roo-monitoring-'));
  const artifact = join(root, 'test-results/monitoring-deployments', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(artifact, { recursive: true });
  await mkdir(join(scratch, 'home'));
  const hostNetwork = await readlink('/proc/self/ns/net');
  const child = spawn('unshare', ['--user', '--map-root-user', '--net', '--',
    'sh', '-ec', 'ip link set lo up; exec "$@"', 'monitoring-sandbox',
    process.execPath, fileURLToPath(import.meta.url), '--sandbox', scratch, artifact, hostNetwork], {
    cwd: root, detached: true, stdio: 'inherit',
    env: {
      PATH: process.env.PATH, HOME: join(scratch, 'home'), TMPDIR: scratch,
      XDG_CONFIG_HOME: join(scratch, 'home/.config'), XDG_CACHE_HOME: join(scratch, 'home/.cache'),
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright'),
      ROO_MONITORING_CASE: process.env.ROO_MONITORING_CASE || '',
      SENTRY_CLI_NO_TELEMETRY: '1', NEXT_TELEMETRY_DISABLED: '1',
    },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop(child));
  try {
    process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done(code ?? 1)); });
  } finally {
    await stop(child);
    await rm(scratch, { recursive: true, force: true });
    console.log(`report: ${join(artifact, 'report.json')}`);
  }
} else {
  await run(process.argv[3], process.argv[4], process.argv[5]);
}

async function run(scratch, artifact, hostNetwork) {
  const { installNetworkGuard, inheritTestProcessGuard, refuseEnvFiles } = await import('./lib/test-target-safety.mjs');
  const { createToolingContentFixture } = await import('../tests/fixtures/tooling-content.mjs');
  const { apiRouteSecrets } = await import('../tests/fixtures/api-routes.mjs');
  const { chromium } = await import('playwright');
  refuseEnvFiles(root);
  const checks = [];
  const cases = [];
  const received = [];
  const blockedBrowserRequests = [];
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ name, ok, actual, expected });
    console.log(`${ok ? 'ok' : 'FAIL'} ${name}`);
  };
  check('test network namespace differs from the host', await readlink('/proc/self/ns/net') === hostNetwork, false);
  check('test network has only loopback interfaces', Object.keys(networkInterfaces()), ['lo']);
  const requests = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = (request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString();
    received.push({ path: request.url, body });
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  const reserve = async () => {
    const server = createServer();
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const port = server.address().port;
    await new Promise(done => server.close(done));
    return `http://127.0.0.1:${port}`;
  };
  await new Promise(done => requests.listen(0, '127.0.0.1', done));
  const sink = `http://127.0.0.1:${requests.address().port}`;
  const site = (await reserve()).replace('127.0.0.1', 'localhost');
  const content = await reserve();
  const dsn = sink.replace('http://', 'http://fixturekey@') + '/42';
  const restoreGuard = installNetworkGuard([site, sink, content]);
  inheritTestProcessGuard(pathToFileURL(join(root, 'scripts/fixtures/sourcemaps-network-guard.mjs')));
  const networkLog = join(artifact, 'network.log');
  const controlLog = join(artifact, 'network-control.log');
  await writeFile(networkLog, '');
  await writeFile(controlLog, '');
  const library = join(scratch, 'network-audit.so');
  const probe = join(scratch, 'network-probe');
  execFileSync('cc', ['-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-o', library,
    join(root, 'scripts/fixtures/sourcemaps-network-audit.c'), '-ldl']);
  execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-Werror', '-o', probe,
    join(root, 'scripts/fixtures/sourcemaps-network-probe.c'), '-ldl']);
  const fixture = await createToolingContentFixture({ origin: content, apiRoutes: true });
  const work = join(scratch, 'site');
  await mkdir(work);
  for (const name of ['app', 'src', 'public', 'instrumentation.js', 'instrumentation-client.js', 'middleware.js',
    'jsconfig.json', 'postcss.config.js', 'tailwind.config.js', 'package.json']) {
    await cp(join(root, name), join(work, name), { recursive: true });
  }
  await cp(join(root, 'next.config.mjs'), join(work, 'next.base.mjs'));
  await writeFile(join(work, 'next.config.mjs'), `import config from './next.base.mjs';
export * from './next.base.mjs';
config.experimental = { ...config.experimental, cpus: 1 };
export default config;
`);
  await symlink(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
  for (const [target, source] of [['app/monitoring-fixture/page.jsx', 'monitoring-page.jsx'],
    ['app/api/monitoring-fixture/route.js', 'monitoring-route.js']]) {
    await mkdir(dirname(join(work, target)), { recursive: true });
    await cp(join(root, 'scripts/fixtures', source), join(work, target));
  }
  await mkdir(join(work, 'app/api/monitoring-edge'), { recursive: true });
  await writeFile(join(work, 'app/api/monitoring-edge/route.js'), `export const runtime = 'edge';
export const dynamic = 'force-dynamic';
export function GET() { throw new Error('Fixture edge error'); }
`);
  const environment = overrides => ({
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: scratch,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    NODE_OPTIONS: process.env.NODE_OPTIONS, TOOLING_NETWORK_GUARD: '1',
    ROO_TEST_NETWORK_ORIGINS: process.env.ROO_TEST_NETWORK_ORIGINS,
    ROO_TEST_HOST: '127.0.0.1', BASE_URL: site,
    LD_PRELOAD: library, ROO_SOURCEMAPS_NETWORK_LOG: networkLog,
    NODE_ENV: 'production', VERCEL: '', VERCEL_ENV: '', CI: '1',
    NEXT_TELEMETRY_DISABLED: '1', SENTRY_CLI_NO_TELEMETRY: '1', SENTRY_LOAD_DOTENV: '0',
    SENTRY_DISABLE_UPDATE_CHECK: '1', SENTRY_AUTH_TOKEN: '', SENTRY_URL: sink,
    SENTRY_DSN: dsn, NEXT_PUBLIC_SENTRY_DSN: dsn, VITE_SENTRY_DSN: dsn, PUBLIC_SENTRY_DSN: dsn,
    NEXT_PUBLIC_VERCEL_ENV: 'production', NEXT_PUBLIC_ROO_SENTRY_ENABLED: '1',
    DATA_PRIMARY_BACKEND: 'supabase', COMMERCE_PRIMARY_BACKEND: 'supabase',
    SUPABASE_CUTOVER_ENABLED: '1', COMMERCE_CUTOVER_ENABLED: '1',
    SUPABASE_URL: content, NEXT_PUBLIC_SUPABASE_URL: content, NEXT_PUBLIC_SUPABASE_ASSET_URL: content,
    SUPABASE_SECRET_KEY: 'fixture-only-server-key', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'fixture-only-browser-key',
    ALLOW_LIVE_PAYMENTS: '0', DODO_PAYMENTS_ENVIRONMENT: 'test_mode', ...apiRouteSecrets, ...overrides,
  });
  let active;
  let browser;
  const execute = async (name, args, env, timeout = 300000) => {
    active = spawn(process.execPath, args, { cwd: work, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const logs = [];
    active.stdout.on('data', chunk => logs.push(chunk));
    active.stderr.on('data', chunk => logs.push(chunk));
    const timer = setTimeout(() => void stop(active), timeout);
    try {
      const code = await new Promise((done, reject) => { active.once('error', reject); active.once('close', done); });
      assert.equal(code, 0, `${name} failed; see its log.`);
    } finally {
      clearTimeout(timer);
      await writeFile(join(artifact, `${name}.log`), Buffer.concat(logs));
      await stop(active);
    }
  };
  const events = rows => rows.flatMap(({ body }) => {
    const lines = body.split('\n');
    const values = [];
    for (let i = 1; i + 1 < lines.length; i += 2) {
      try { if (JSON.parse(lines[i]).type === 'event') values.push(JSON.parse(lines[i + 1])); } catch {}
    }
    return values;
  });
  const hasError = (rows, message) => events(rows).some(event => event.exception?.values?.some(value => value.value === message));
  try {
    execFileSync(probe, [], { env: environment({ ROO_SOURCEMAPS_NETWORK_LOG: controlLog }) });
    await execute('node-network-control', ['--input-type=module', '-e',
      'await fetch("https://monitoring-fixture.invalid/").catch(() => {});'], environment({ ROO_SOURCEMAPS_NETWORK_LOG: controlLog }));
    const controls = await readFile(controlLog, 'utf8');
    check('native and Node outbound checks detect blocked connections',
      ['BLOCK-native-dns', 'BLOCK-native-connect', 'BLOCK-node-transport'].every(value => controls.includes(value)), true);
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    const next = join(root, 'node_modules/next/dist/bin/next');
    const modes = [
      { name: 'local', env: { CI: '' } },
      { name: 'ci', env: { VERCEL_ENV: 'production' } },
      { name: 'preview', env: { VERCEL: '1', VERCEL_ENV: 'preview' } },
      { name: 'vercel-development', env: { VERCEL: '1', VERCEL_ENV: 'development' } },
      { name: 'production', env: { VERCEL: '1', VERCEL_ENV: 'production', NEXT_PUBLIC_ROO_SENTRY_ENABLED: '0' }, enabled: true },
      { name: 'production-artifact-local', env: {}, reuse: 'production' },
      { name: 'next-dev', env: { NODE_ENV: 'development', CI: '', VERCEL: '1', VERCEL_ENV: 'production' }, dev: true },
    ].filter(mode => !process.env.ROO_MONITORING_CASE || mode.name === process.env.ROO_MONITORING_CASE ||
      process.env.ROO_MONITORING_CASE === 'production-artifact-local' && mode.name === 'production');
    assert(modes.length, 'Unknown ROO_MONITORING_CASE.');
    for (const mode of modes) {
      const from = received.length;
      const dist = `.next-e2e-monitoring-${mode.reuse || mode.name}`;
      if (mode.dev) inheritTestProcessGuard(pathToFileURL(join(root, 'scripts/fixtures/monitoring-dev-preload.mjs')));
      const env = environment({ ...mode.env, NEXT_DIST_DIR: dist });
      console.log(`checking ${mode.name}`);
      if (!mode.dev && !mode.reuse) await execute(`${mode.name}-build`, [next, 'build'], env);
      active = spawn(process.execPath, [next, mode.dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', new URL(site).port],
        { cwd: work, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const logs = [];
      active.stdout.on('data', chunk => logs.push(chunk));
      active.stderr.on('data', chunk => logs.push(chunk));
      try {
        let ready = false;
        for (let i = 0; i < 120; i++) {
          if (active.exitCode !== null) break;
          if (await fetch(`${site}/monitoring-fixture`).then(response => response.ok, () => false)) { ready = true; break; }
          await delay(500);
        }
        assert(ready, `${mode.name} did not start.`);
        const requestDetails = await fetch(`${site}/api/monitoring-fixture?request=1`, { headers: { Origin: site } }).then(response => response.json());
        check(`${mode.name}: fixture and browser origins match`, new URL(requestDetails.url).origin, site);
        check(`${mode.name}: uncaught server route still fails`, (await fetch(`${site}/api/monitoring-fixture`)).status, 500);
        check(`${mode.name}: direct server initializer remains callable`, (await fetch(`${site}/api/monitoring-fixture?direct=1`)).status, 200);
        await fetch(`${content}/__fixture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ failure: 'settings' }) });
        const booking = await fetch(`${site}/api/holdSlot`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startTimeUTC: '2099-01-05T10:00:00.000Z', packageTitle: 'Performance Vertex' }) });
        check(`${mode.name}: actual booking failure response`, [booking.status, (await booking.json()).message],
          [500, 'Failed to reserve this slot. Please try again.']);
        await fetch(`${content}/__fixture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ failure: '' }) });
        check(`${mode.name}: edge error remains outside reporting`, (await fetch(`${site}/api/monitoring-edge`)).status, 500);
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const relayRequests = [];
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (![site, content].includes(url.origin)) {
            blockedBrowserRequests.push({ mode: mode.name, url: url.origin });
            return route.abort();
          }
          if (url.pathname === '/api/client-report') relayRequests.push(route.request().method());
          return route.continue();
        });
        await context.tracing.start({ screenshots: true, snapshots: true });
        try {
          const page = await context.newPage();
          await page.goto(`${site}/monitoring-fixture`);
          await page.waitForFunction(() => document.body.dataset.monitoringReady === '1');
          await page.getByRole('button', { name: 'Uncaught error', exact: true }).evaluate(button => button.click());
          await page.getByRole('button', { name: 'Rejected promise' }).evaluate(button => button.click());
          await page.getByRole('button', { name: 'Reported error' }).evaluate(button => button.click());
          await delay(mode.dev ? 4000 : 2000);
          if (!mode.enabled && !mode.reuse) check(`${mode.name}: bootstrap sends no browser envelopes`, relayRequests.length, 0);
          await page.getByRole('button', { name: 'Direct initializer' }).evaluate(button => button.click());
          await delay(mode.dev ? 4000 : 2000);
          await page.getByRole('button', { name: 'Error boundary' }).evaluate(button => button.click());
          await page.getByRole('heading', { name: 'We couldn’t load this page.' }).waitFor();
          await page.screenshot({ path: join(artifact, `${mode.name}.png`) });
          if (mode.enabled) {
            for (let i = 0; i < 40 && !hasError(received.slice(from), 'Fixture browser boundary'); i++) await delay(250);
          } else await delay(2000);
          if (!mode.enabled && !mode.reuse) check(`${mode.name}: all browser actions send no relay requests`, relayRequests.length, 0);
        } finally {
          await context.tracing.stop({ path: join(artifact, `${mode.name}-trace.zip`) });
          await context.close();
        }
        const relay = await fetch(`${site}/api/client-report`, { method: 'POST', headers: { Origin: site },
          body: `${JSON.stringify({ dsn })}\n{"type":"event"}\n{"message":"Fixture direct relay"}\n` });
        check(`${mode.name}: relay deployment gate`, relay.status, mode.enabled ? 200 : 404);
        if (!mode.enabled) await delay(2000);
        const rows = received.slice(from);
        if (mode.enabled) {
          for (const message of ['Fixture server uncaught', 'Fixture server direct', 'Slot hold failed',
            'Fixture browser uncaught', 'Fixture browser rejection', 'Fixture browser reported', 'Fixture browser direct', 'Fixture browser boundary']) {
            check(`production: ${message} reaches the sink`, hasError(rows, message), true);
          }
        } else check(`${mode.name}: no envelope reaches the sink`, rows.length, 0);
        if (!mode.enabled) check(`${mode.name}: edge sends no event`, hasError(rows, 'Fixture edge error'), false);
        check(`${mode.name}: caught booking label logged locally`, Buffer.concat(logs).toString().includes('Slot hold failed'), true);
        cases.push({ name: mode.name, requestDetails, deployment: { nodeEnv: env.NODE_ENV, vercel: env.VERCEL, vercelEnv: env.VERCEL_ENV, ci: env.CI },
          envelopes: rows.length, events: events(rows), relayStatus: relay.status, browserRelayRequests: relayRequests.length });
      } finally {
        if (mode.name === 'local') {
          const kill = process.kill;
          let injected = false;
          let closed = false;
          const onClose = () => { closed = true; };
          active.once('close', onClose);
          process.kill = function (pid, signal) {
            const result = kill.call(process, pid, signal);
            if (!injected && pid === -active.pid && signal === 'SIGTERM') {
              injected = true;
              throw Object.assign(new Error('Fixture missing process group'), { code: 'ESRCH' });
            }
            return result;
          };
          try { await stop(active); } finally { process.kill = kill; active.removeListener('close', onClose); }
          check('local: cleanup waits for child close after an ESRCH termination result', [injected, closed], [true, true]);
        } else await stop(active);
        if (!mode.enabled) check(`${mode.name}: shutdown sends no late envelope`, received.length - from, 0);
        await writeFile(join(artifact, `${mode.name}-server.log`), Buffer.concat(logs));
      }
    }
    check('no browser request targets an external origin', blockedBrowserRequests, []);
    check('no application or build attempts an outbound connection', await readFile(networkLog, 'utf8'), '');
  } catch (error) {
    check('deployment E2E completes', error.stack, null);
  } finally {
    await stop(active);
    await browser?.close();
    await fixture.close();
    requests.closeAllConnections();
    await new Promise(done => requests.close(done));
    restoreGuard();
    const report = { ok: checks.length > 0 && checks.every(check => check.ok), selectedCase: process.env.ROO_MONITORING_CASE || 'all', checks, cases, blockedBrowserRequests,
      fixture: 'Complete copied website, real Next builds and browser, local Sentry and Supabase stand-ins, no hosted credentials. Next dev registry version metadata is served in memory.' };
    await writeFile(join(artifact, 'report.json'), JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  }
}
