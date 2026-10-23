import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { inheritTestProcessGuard, installNetworkGuard, localOrigin, refuseEnvFiles, validateDistDir } from './lib/test-target-safety.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);
refuseEnvFiles();
refuseEnvFiles(root);
const token = 'SOURCEMAPS_FAKE_UPLOAD_SENTINEL_525';
const buildSha = '5250000000000000000000000000000000000000';
const missingTokenWarning = 'Sentry source-map upload skipped: SENTRY_AUTH_TOKEN is missing for the Vercel production build.';

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function privateFiles(directory) {
  for (const path of await files(directory)) {
    assert(!(await readFile(path)).includes(Buffer.from(token)), 'The build contains the fake upload token.');
  }
}

function stopGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function uploadedMap(bundle, js, originalSource) {
  const readEntry = name => execFileSync('unzip', ['-p', bundle, name], { encoding: 'utf8' });
  const manifest = JSON.parse(readEntry('manifest.json'));
  const paths = Object.keys(manifest.files);
  for (const path of ['manifest.json', ...paths]) {
    assert(!readEntry(path).includes(token), 'The uploaded archive contains the fake token.');
  }
  const maps = paths.filter(path => path.endsWith('.map')).map(path => JSON.parse(readEntry(path)));
  const map = maps.find(map => /^[a-f0-9-]{36}$/i.test(map.debug_id) && js.includes(map.debug_id));
  assert(map, 'The uploaded bundle is missing the matching browser source map.');
  assert(map.sourcesContent.some(source => source?.includes(originalSource)), 'The uploaded map is missing the original fixture source.');
  assert(paths.filter(path => path.endsWith('.js')).some(path => readEntry(path).includes(map.debug_id)),
    'The uploaded bundle is missing the matching browser JavaScript.');
  return map.debug_id;
}

if (process.argv[2] === '--build') {
  const directory = process.argv[3];
  const { default: nextConfig } = await import(pathToFileURL(process.env.SOURCEMAPS_CONFIG || join(root, 'next.config.mjs')));
  const require = createRequire(import.meta.url);
  const bundled = require('next/dist/compiled/webpack/webpack');
  bundled.init();
  const { webpack } = bundled;
  const config = nextConfig.webpack({ mode: 'production', target: 'web', context: root,
    entry: { main: join(directory, 'entry.js'), secondary: join(directory, 'secondary.js') },
    output: { path: join(directory, 'static/chunks'), filename: data =>
      data.chunk.name === 'secondary' ? 'pages/secondary-fixture.js' : '[name]-fixture.js' },
    optimization: { minimize: false, splitChunks: { cacheGroups: {
      shared: { test: /shared\.js$/, name: 'shared', chunks: 'all', minSize: 0, enforce: true },
    } } }, plugins: [],
  }, { dir: root, dev: false, isServer: false, webpack, buildId: 'source-map-fixture',
    config: { ...nextConfig, distDir: relative(root, directory) } });
  await new Promise((resolveBuild, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => compiler.close(closeError => {
      if (error || closeError || stats?.hasErrors()) reject(error || closeError || new Error(stats.toString({ all: false, errors: true })));
      else resolveBuild();
    }));
  });
} else {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('SENTRY_') || name.startsWith('NEXT_PUBLIC_SENTRY_')) delete process.env[name];
  }
  process.env.SENTRY_CLI_NO_TELEMETRY = '1';
  const fixture = await mkdtemp(join(tmpdir(), 'website-sourcemaps-'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifact = join(root, 'test-results/sourcemaps-e2e', stamp);
  const networkLog = join(artifact, 'network.log');
  const controlLog = join(artifact, 'guard-control.network.log');
  const report = { ok: false, buildSha, scenarios: [] };
  const requests = [];
  const uploadedChunks = new Map();
  let content, server, restoreGuard, productionDist;
  let rejectUpload = false;
  let bundlePath;
  let uploadError;
  try {
    await mkdir(artifact, { recursive: true });
    await writeFile(networkLog, '');
    await writeFile(controlLog, '');
    const auditLibrary = join(fixture, 'network-audit.so');
    const nativeProbe = join(fixture, 'network-probe');
    execFileSync('cc', ['-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-o', auditLibrary,
      join(root, 'scripts/fixtures/sourcemaps-network-audit.c'), '-ldl']);
    execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-Werror', '-o', nativeProbe,
      join(root, 'scripts/fixtures/sourcemaps-network-probe.c'), '-ldl']);
    await mkdir(join(fixture, 'home'));
    await writeFile(join(fixture, 'empty-sentry.ini'), '');
    const reservation = createServer();
    const reserve = async () => {
      await new Promise(done => reservation.listen(0, '127.0.0.1', done));
      const origin = localOrigin(`http://127.0.0.1:${reservation.address().port}`);
      await new Promise(done => reservation.close(done));
      return origin;
    };
    const siteOrigin = await reserve();
    const contentOrigin = await reserve();
    productionDist = validateDistDir(`.next-e2e-sourcemaps-${stamp}`, { isolated: true });
    server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const record = { method: request.method, path: request.url, bytes: body.length };
      requests.push(record);
      response.setHeader('Content-Type', 'application/json');
      try {
        if (rejectUpload && request.url === '/chunks/') response.writeHead(403).end(JSON.stringify({ detail: 'fixture rejects upload' }));
        else if (request.url.endsWith('/chunk-upload/')) response.end(JSON.stringify({
          url: `${origin}/chunks/`, chunkSize: 8388608, chunksPerRequest: 16, maxFileSize: 2147483648,
          maxRequestSize: 33554432, hashAlgorithm: 'sha1', concurrency: 1, compression: ['gzip'], accept: ['artifact_bundles'],
        }));
        else if (request.url === '/chunks/') {
          const form = await new Response(body, { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
          for (const [encoding, file] of form) {
            assert(encoding === 'file' || encoding === 'file_gzip');
            const raw = Buffer.from(await file.arrayBuffer());
            const data = encoding === 'file_gzip' || request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
            assert(data.length > 0);
            assert.equal(createHash('sha1').update(data).digest('hex'), file.name);
            uploadedChunks.set(file.name, data);
          }
          response.end('[]');
        } else if (request.url.endsWith('/artifactbundle/assemble/')) {
          const assembly = JSON.parse(body);
          record.release = assembly.version ?? assembly.release ?? null;
          const missingChunks = assembly.chunks.filter(hash => !uploadedChunks.has(hash));
          if (missingChunks.length === 0) {
            const bundle = Buffer.concat(assembly.chunks.map(hash => uploadedChunks.get(hash)));
            assert.equal(createHash('sha1').update(bundle).digest('hex'), assembly.checksum);
            await writeFile(bundlePath, bundle);
          }
          response.end(JSON.stringify({ state: missingChunks.length ? 'not_found' : 'created', missingChunks, detail: null }));
        }
        else response.writeHead(404).end('{}');
      } catch (error) {
        uploadError = error;
        response.writeHead(400).end(JSON.stringify({ detail: 'Invalid fixture upload.' }));
      }
    });
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const origin = `http://127.0.0.1:${server.address().port}`;
    restoreGuard = installNetworkGuard([origin, siteOrigin, contentOrigin]);
    inheritTestProcessGuard(pathToFileURL(join(root, 'scripts/fixtures/sourcemaps-network-guard.mjs')));

    function environment(overrides = {}) {
      return {
        PATH: process.env.PATH, HOME: join(fixture, 'home'), TMPDIR: fixture,
        XDG_CONFIG_HOME: join(fixture, 'home/.config'), XDG_CACHE_HOME: join(fixture, 'home/.cache'),
        NODE_OPTIONS: process.env.NODE_OPTIONS, ROO_TEST_HOST: '127.0.0.1', BASE_URL: siteOrigin,
        TOOLING_NETWORK_GUARD: '1', ROO_TEST_NETWORK_ORIGINS: process.env.ROO_TEST_NETWORK_ORIGINS,
        LD_PRELOAD: [auditLibrary, process.env.LD_PRELOAD].filter(Boolean).join(':'), ROO_SOURCEMAPS_NETWORK_LOG: networkLog,
        NODE_ENV: 'production', CI: '1', NEXT_TELEMETRY_DISABLED: '1',
        VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production',
        VERCEL_GIT_COMMIT_SHA: buildSha, SENTRY_RELEASE: '',
        SENTRY_AUTH_TOKEN: token, SENTRY_URL: origin, SENTRY_LOG_LEVEL: 'error',
        SENTRY_CLI_NO_TELEMETRY: '1', SENTRY_DISABLE_UPDATE_CHECK: '1', SENTRY_FORCE_ENV_TOKEN: '1',
        SENTRY_LOAD_DOTENV: '0', SENTRY_CONFIG_FILE: join(fixture, 'empty-sentry.ini'),
        NEXT_PUBLIC_SENTRY_DSN: '', SENTRY_DSN: '',
        SOURCEMAPS_CONFIG: process.env.SOURCEMAPS_CONFIG,
        ...overrides,
      };
    }

    async function noOutboundAttempts() {
      assert.equal(await readFile(networkLog, 'utf8'), '', 'A source-map child attempted a nonlocal connection.');
    }

    async function execute(name, args, env, { cwd = root, timeout = 60000 } = {}) {
      const child = spawn(process.execPath, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      const logs = [];
      child.stdout.on('data', data => logs.push(data));
      child.stderr.on('data', data => logs.push(data));
      let escalation;
      const timer = setTimeout(() => {
        stopGroup(child, 'SIGTERM');
        escalation = setTimeout(() => stopGroup(child, 'SIGKILL'), 2000);
      }, timeout);
      const status = await new Promise((done, reject) => {
        child.once('error', reject); child.once('close', done);
      }).finally(() => { clearTimeout(timer); clearTimeout(escalation); });
      const log = Buffer.concat(logs).toString();
      await writeFile(join(artifact, `${name}.log`), log);
      assert(!log.includes(token), 'The child logged the fake upload token.');
      return { status, log };
    }

    async function build(name, overrides = {}) {
      uploadedChunks.clear();
      uploadError = undefined;
      bundlePath = join(artifact, `${name}.zip`);
      const directory = join(fixture, name);
      await mkdir(directory);
      await writeFile(join(directory, 'entry.js'), 'import { shared } from "./shared.js"; console.log("source-map fixture", shared);\n');
      await writeFile(join(directory, 'secondary.js'), 'import { shared } from "./shared.js"; console.log("secondary fixture", shared);\n');
      await writeFile(join(directory, 'shared.js'), 'export const shared = "shared source-map fixture";\n');
      const result = await execute(name, [self, '--build', directory], environment(overrides));
      assert.ifError(uploadError);
      await noOutboundAttempts();
      await privateFiles(directory);
      return { ...result, output: join(directory, 'static/chunks'), bundle: bundlePath };
    }

    async function productionWithoutToken() {
      const { createToolingContentFixture } = await import('../tests/fixtures/tooling-content.mjs');
      content = await createToolingContentFixture({ origin: contentOrigin, artifact: join(artifact, 'content-fixture.json') });
      const env = environment({
        SENTRY_AUTH_TOKEN: '', NEXT_DIST_DIR: productionDist,
        TOURNEY_DATABASE_MODE: 'memory', DATA_PRIMARY_BACKEND: 'supabase', COMMERCE_PRIMARY_BACKEND: 'supabase',
        SUPABASE_CUTOVER_ENABLED: '1', COMMERCE_CUTOVER_ENABLED: '1',
        SUPABASE_URL: contentOrigin, NEXT_PUBLIC_SUPABASE_URL: contentOrigin, NEXT_PUBLIC_SUPABASE_ASSET_URL: contentOrigin,
        SUPABASE_SECRET_KEY: 'fixture-only-tooling-server-secret-key',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'fixture-only-tooling-browser-publishable-key',
        ALLOW_LIVE_PAYMENTS: '0', SALES_PREVIEW_READ_ONLY: '1',
      });
      const start = requests.length;
      const result = await execute('production-missing-token-build', [join(root, 'node_modules/next/dist/bin/next'), 'build'], env, { timeout: 900000 });
      assert.equal(result.status, 0);
      assert.equal(result.log.split(missingTokenWarning).length - 1, 1);
      assert.equal(requests.length, start);
      const output = join(root, productionDist);
      const generated = JSON.parse(await readFile(join(output, 'required-server-files.json'), 'utf8'));
      assert.equal(generated.config.env?._sentryRelease, buildSha);
      await privateFiles(output);
      const browserFiles = await files(join(output, 'static'));
      assert(!browserFiles.some(path => path.endsWith('.map')));
      const site = new URL(siteOrigin);
      const child = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start',
        '--hostname', site.hostname, '--port', site.port], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const logs = [];
      child.stdout.on('data', data => logs.push(data));
      child.stderr.on('data', data => logs.push(data));
      let spawnError;
      child.once('error', error => { spawnError = error; });
      const closed = new Promise(done => child.once('close', done));
      const probes = [];
      try {
        let home;
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && !spawnError) {
          if (Buffer.concat(logs).toString().includes('Ready in')) {
            home = await fetch(siteOrigin, { signal: AbortSignal.timeout(2000) }).catch(() => null);
            if (home) break;
          }
          await new Promise(done => setTimeout(done, 100));
        }
        assert.ifError(spawnError);
        assert.equal(home?.status, 200);
        assert(!(await home.text()).includes(token));
        const paths = browserFiles.filter(path => path.endsWith('.js')).map(path => `/_next/static/${relative(join(output, 'static'), path)}.map`);
        paths.push('/_next/server/app/page.js.map', `/${productionDist}/server/app/page.js.map`);
        for (const path of paths) {
          const response = await fetch(siteOrigin + path, { signal: AbortSignal.timeout(3000) });
          probes.push({ path, status: response.status });
          await response.body?.cancel();
          assert.equal(response.status, 404);
        }
      } finally {
        stopGroup(child, 'SIGTERM');
        const escalation = setTimeout(() => stopGroup(child, 'SIGKILL'), 5000);
        await closed.finally(() => clearTimeout(escalation));
        stopGroup(child, 'SIGKILL');
        const log = Buffer.concat(logs).toString();
        await writeFile(join(artifact, 'production-missing-token-start.log'), log);
        assert(!log.includes(token));
      }
      await noOutboundAttempts();
      return { name: 'production-missing-token', status: result.status, missingTokenWarning: true, homepageStatus: 200, mapProbes: probes };
    }

    execFileSync('bwrap', ['--unshare-net', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      '--bind', artifact, artifact, nativeProbe], { env: environment({ ROO_SOURCEMAPS_NETWORK_LOG: controlLog }) });
    const nativeControl = await readFile(controlLog, 'utf8');
    assert(nativeControl.includes('BLOCK-native-connect') && nativeControl.includes('BLOCK-native-dns'));
    const nodeControl = await execute('caught-node-network-control', ['--input-type=module', '-e',
      'await fetch("https://sourcemaps-guard.invalid").catch(() => {});'], environment({ ROO_SOURCEMAPS_NETWORK_LOG: controlLog }));
    assert.equal(nodeControl.status, 0);
    assert((await readFile(controlLog, 'utf8')).includes('BLOCK-node-transport'));
    const envDirectory = join(fixture, 'env-file-refusal');
    await mkdir(envDirectory);
    await writeFile(join(envDirectory, '.env'), `SENTRY_AUTH_TOKEN=${token}\n`);
    const refusedEnv = await execute('env-file-refusal', [self, '--build', envDirectory], environment(), { cwd: envDirectory });
    assert.equal(refusedEnv.status, 1);
    assert(refusedEnv.log.includes('[test-target] Remove local env files'));
    assert.equal(requests.length, 0);
    await noOutboundAttempts();
    const withoutToken = await build('without-token', { SENTRY_AUTH_TOKEN: '', VERCEL: '', VERCEL_ENV: '', CI: '' });
    assert.equal(withoutToken.status, 0);
    assert(!withoutToken.log.includes('Sentry source-map'));
    assert.equal((await readdir(withoutToken.output, { recursive: true })).some(file => file.endsWith('.map')), false);
    assert.equal(requests.length, 0);
    for (const [name, settings] of [
      ['local', { VERCEL: '', VERCEL_ENV: '', CI: '' }],
      ['ci', { VERCEL: '', VERCEL_ENV: '', CI: '1' }],
      ['development', { VERCEL_ENV: 'development' }],
      ['preview', { VERCEL_ENV: 'preview' }],
      ['unverified-production', { VERCEL: '' }],
    ]) {
      const start = requests.length;
      const disabled = await build(name, settings);
      assert.equal(disabled.status, 0);
      assert(!disabled.log.includes('Sentry source-map'));
      assert.equal(requests.length, start);
      assert.equal((await readdir(disabled.output, { recursive: true })).some(file => file.endsWith('.map')), false);
      report.scenarios.push({ name, status: disabled.status, sentryRequests: 0, warnings: false, publicMaps: false });
    }
    const uploaded = await build('uploaded');
    assert.equal(uploaded.status, 0);
    assert(!uploaded.log.includes('Sentry source-map upload failed.'));
    assert(uploadedChunks.size > 0);
    assert(requests.some(request => request.path.endsWith('/artifactbundle/assemble/')));
    assert.equal((await readdir(uploaded.output, { recursive: true })).some(file => file.endsWith('.map')), false);
    const js = await readFile(join(uploaded.output, 'main-fixture.js'), 'utf8');
    assert(js.includes('_sentryDebugIds'));
    assert(!js.includes('sourceMappingURL='));
    const mainMapDebugId = uploadedMap(uploaded.bundle, js, 'source-map fixture');
    const shared = await readFile(join(uploaded.output, 'shared-fixture.js'), 'utf8');
    const sharedMapDebugId = uploadedMap(uploaded.bundle, shared, 'shared source-map fixture');
    assert(requests.filter(request => request.path.endsWith('/artifactbundle/assemble/')).every(request => request.release === buildSha));
    const withoutRelease = await build('without-release', { VERCEL_GIT_COMMIT_SHA: '' });
    assert.equal(withoutRelease.status, 0);
    assert(!withoutRelease.log.includes('Sentry source-map upload failed.'));
    uploadedMap(withoutRelease.bundle, await readFile(join(withoutRelease.output, 'main-fixture.js'), 'utf8'), 'source-map fixture');
    assert(!requests.some(request => request.path.includes('/releases/')));
    const telemetryOptOut = await build('config-telemetry-opt-out', { SENTRY_CLI_NO_TELEMETRY: '0' });
    assert.equal(telemetryOptOut.status, 0);
    uploadedMap(telemetryOptOut.bundle, await readFile(join(telemetryOptOut.output, 'main-fixture.js'), 'utf8'), 'source-map fixture');
    rejectUpload = true;
    const rejectedStart = requests.length;
    const rejected = await build('rejected');
    assert.equal(rejected.status, 0);
    assert(rejected.log.includes('Sentry source-map upload failed.'));
    assert(requests.slice(rejectedStart).some(request => request.method === 'POST' && request.path === '/chunks/'));
    assert.equal((await readdir(rejected.output, { recursive: true })).some(file => file.endsWith('.map')), false);
    rejectUpload = false;
    report.scenarios.push(await productionWithoutToken());
    await noOutboundAttempts();
    Object.assign(report, { ok: true, noTokenNeedsNoUpload: true,
      mainBrowserChunkUploaded: true, mainMapDebugId, sharedMapDebugId, originalSourcesUploaded: true,
      debugIdsPresent: true, publicMapsRemoved: true,
      uploadFailureWarnsAndPreservesBuild: true, failedUploadMapsRemainPrivate: true,
      releaseMatchesBuild: true, cliTelemetryDisabled: true, guardControlsRefused: true, envFilesRefused: true,
      nonlocalConnectionAttempts: 0, requests });
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      content?.close(),
      server?.listening ? new Promise(done => { server.closeAllConnections(); server.close(done); }) : undefined,
    ]);
    restoreGuard?.();
    if (productionDist) await rm(join(root, productionDist), { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
    const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason.message);
    if (errors.length) { report.ok = false; report.cleanupErrors = errors; process.exitCode = 1; }
    await writeFile(join(artifact, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
    report.networkAudit = await readFile(networkLog, 'utf8').catch(() => null);
    await writeFile(join(artifact, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (report.ok) console.log(`Source-map E2E passed: ${artifact}`);
}
