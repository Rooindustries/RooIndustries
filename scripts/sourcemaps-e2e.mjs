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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);

function uploadedMap(bundle, js, originalSource) {
  const readEntry = name => execFileSync('unzip', ['-p', bundle, name], { encoding: 'utf8' });
  const manifest = JSON.parse(readEntry('manifest.json'));
  const paths = Object.keys(manifest.files);
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
  const fixture = await mkdtemp(join(tmpdir(), 'website-sourcemaps-'));
  const artifact = join(root, 'test-results/sourcemaps-e2e', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(artifact, { recursive: true });
  const requests = [];
  const uploadedChunks = new Map();
  let rejectUpload = false;
  let bundlePath;
  let uploadError;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: request.method, path: request.url, bytes: body.length });
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

  async function build(name, token, release = 'source-map-fixture-release') {
    uploadedChunks.clear();
    uploadError = undefined;
    bundlePath = join(artifact, `${name}.zip`);
    const directory = join(fixture, name);
    await mkdir(directory);
    await writeFile(join(directory, 'entry.js'), 'import { shared } from "./shared.js"; console.log("source-map fixture", shared);\n');
    await writeFile(join(directory, 'secondary.js'), 'import { shared } from "./shared.js"; console.log("secondary fixture", shared);\n');
    await writeFile(join(directory, 'shared.js'), 'export const shared = "shared source-map fixture";\n');
    const child = spawn(process.execPath, [self, '--build', directory], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview', SENTRY_AUTH_TOKEN: token, SENTRY_URL: origin,
        SENTRY_RELEASE: release, VERCEL_GIT_COMMIT_SHA: '', NEXT_PUBLIC_SENTRY_DSN: '', SENTRY_LOG_LEVEL: 'error', SENTRY_DISABLE_UPDATE_CHECK: '1', SENTRY_FORCE_ENV_TOKEN: '1' },
    });
    const logs = [];
    child.stdout.on('data', data => logs.push(data));
    child.stderr.on('data', data => logs.push(data));
    const stop = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    let escalation;
    const timer = setTimeout(() => { stop('SIGTERM'); escalation = setTimeout(() => stop('SIGKILL'), 2000); }, 60000);
    const status = await new Promise((resolveExit, reject) => {
      child.once('error', reject); child.once('close', resolveExit);
    }).finally(() => { clearTimeout(timer); clearTimeout(escalation); });
    const log = Buffer.concat(logs).toString();
    await writeFile(join(artifact, `${name}.log`), log);
    assert.ifError(uploadError);
    return { status, log, output: join(directory, 'static/chunks'), bundle: bundlePath };
  }

  try {
    const withoutToken = await build('without-token', '');
    assert.equal(withoutToken.status, 0);
    assert.equal((await readdir(withoutToken.output, { recursive: true })).some(file => file.endsWith('.map')), false);
    assert.equal(requests.length, 0);
    const uploaded = await build('uploaded', 'fixture-token');
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
    const withoutRelease = await build('without-release', 'fixture-token', '');
    assert.equal(withoutRelease.status, 0);
    assert(!withoutRelease.log.includes('Sentry source-map upload failed.'));
    uploadedMap(withoutRelease.bundle, await readFile(join(withoutRelease.output, 'main-fixture.js'), 'utf8'), 'source-map fixture');
    assert(!requests.some(request => request.path.includes('/releases/')));
    rejectUpload = true;
    const rejectedStart = requests.length;
    const rejected = await build('rejected', 'fixture-token');
    assert.equal(rejected.status, 0);
    assert(rejected.log.includes('Sentry source-map upload failed.'));
    assert(requests.slice(rejectedStart).some(request => request.method === 'POST' && request.path === '/chunks/'));
    assert.equal((await readdir(rejected.output, { recursive: true })).some(file => file.endsWith('.map')), false);
    await writeFile(join(artifact, 'report.json'), JSON.stringify({ ok: true, noTokenNeedsNoUpload: true,
      mainBrowserChunkUploaded: true, mainMapDebugId, sharedMapDebugId, originalSourcesUploaded: true,
      debugIdsPresent: true, publicMapsRemoved: true,
      uploadFailureWarnsAndPreservesBuild: true, failedUploadMapsRemainPrivate: true, requests }, null, 2) + '\n');
    console.log(`Source-map E2E passed: ${artifact}`);
  } finally {
    await writeFile(join(artifact, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(fixture, { recursive: true, force: true });
  }
}
