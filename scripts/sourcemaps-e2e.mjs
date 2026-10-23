import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);

if (process.argv[2] === '--build') {
  const directory = process.argv[3];
  const { default: nextConfig } = await import(pathToFileURL(process.env.SOURCEMAPS_CONFIG || join(root, 'next.config.mjs')));
  const require = createRequire(import.meta.url);
  const bundled = require('next/dist/compiled/webpack/webpack');
  bundled.init();
  const { webpack } = bundled;
  const config = nextConfig.webpack({ mode: 'production', target: 'web', context: root,
    entry: { fixture: join(directory, 'entry.js') },
    output: { path: join(directory, 'static/chunks'), filename: 'main-fixture.js' },
    optimization: { minimize: false, splitChunks: { cacheGroups: {} } }, plugins: [],
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
  let rejectUpload = false;
  let chunkUploaded = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: request.method, path: request.url, bytes: body.length });
    response.setHeader('Content-Type', 'application/json');
    if (rejectUpload) response.writeHead(403).end(JSON.stringify({ detail: 'fixture rejects upload' }));
    else if (request.url.endsWith('/chunk-upload/')) response.end(JSON.stringify({
      url: `${origin}/chunks/`, chunkSize: 8388608, chunksPerRequest: 16, maxFileSize: 2147483648,
      maxRequestSize: 33554432, hashAlgorithm: 'sha1', concurrency: 1, compression: ['gzip'], accept: ['artifact_bundles'],
    }));
    else if (request.url === '/chunks/') { chunkUploaded = true; response.end('[]'); }
    else if (request.url.endsWith('/artifactbundle/assemble/')) response.end(JSON.stringify({
      state: chunkUploaded ? 'created' : 'not_found', missingChunks: chunkUploaded ? [] : JSON.parse(body).chunks, detail: null,
    }));
    else response.writeHead(404).end('{}');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function build(name, token) {
    const directory = join(fixture, name);
    await mkdir(directory);
    await writeFile(join(directory, 'entry.js'), 'console.log("source-map fixture");\n');
    const child = spawn(process.execPath, [self, '--build', directory], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', SENTRY_AUTH_TOKEN: token, SENTRY_URL: origin,
        NEXT_PUBLIC_SENTRY_DSN: '', SENTRY_LOG_LEVEL: 'error', SENTRY_DISABLE_UPDATE_CHECK: '1', SENTRY_FORCE_ENV_TOKEN: '1' },
    });
    const logs = [];
    child.stdout.on('data', data => logs.push(data));
    child.stderr.on('data', data => logs.push(data));
    const stop = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    let escalation;
    const timer = setTimeout(() => { stop('SIGTERM'); escalation = setTimeout(() => stop('SIGKILL'), 2000); }, 60000);
    const status = await new Promise((resolveExit, reject) => {
      child.once('error', reject); child.once('exit', resolveExit);
    }).finally(() => { clearTimeout(timer); clearTimeout(escalation); });
    const log = Buffer.concat(logs).toString();
    await writeFile(join(artifact, `${name}.log`), log);
    return { status, log, output: join(directory, 'static/chunks') };
  }

  try {
    const withoutToken = await build('without-token', '');
    assert.equal(withoutToken.status, 0);
    assert.equal((await readdir(withoutToken.output)).some(file => file.endsWith('.map')), false);
    assert.equal(requests.length, 0);
    const uploaded = await build('uploaded', 'fixture-token');
    assert.equal(uploaded.status, 0);
    assert(chunkUploaded, 'The main browser chunk must be uploaded.');
    assert(requests.some(request => request.path.endsWith('/artifactbundle/assemble/')));
    assert.equal((await readdir(uploaded.output)).some(file => file.endsWith('.map')), false);
    const js = await readFile(join(uploaded.output, 'main-fixture.js'), 'utf8');
    assert(js.includes('_sentryDebugIds'));
    assert(!js.includes('sourceMappingURL='));
    rejectUpload = true;
    const rejected = await build('rejected', 'fixture-token');
    assert.equal(rejected.status, 0);
    assert(rejected.log.includes('Sentry source-map upload failed.'));
    assert.equal((await readdir(rejected.output)).some(file => file.endsWith('.map')), false);
    await writeFile(join(artifact, 'report.json'), JSON.stringify({ ok: true, noTokenNeedsNoUpload: true,
      mainBrowserChunkUploaded: true, debugIdsPresent: true, publicMapsRemoved: true,
      uploadFailureWarnsAndPreservesBuild: true, failedUploadMapsRemainPrivate: true, requests }, null, 2) + '\n');
    console.log(`Source-map E2E passed: ${artifact}`);
  } finally {
    await writeFile(join(artifact, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(fixture, { recursive: true, force: true });
  }
}
