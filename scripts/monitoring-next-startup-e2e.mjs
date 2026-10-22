import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { installNetworkGuard, localOrigin, refuseEnvFiles, validateDistDir } from './lib/test-target-safety.mjs';

refuseEnvFiles();
const host = process.env.ROO_TEST_HOST || '127.0.0.1';
const port = Number(process.env.PW_PORT || 3459);
if (!Number.isInteger(port) || port < 1024 || port >= 65535) throw new Error('Startup check requires an unprivileged fixture port pair.');
const origin = localOrigin(process.env.BASE_URL || `http://${host}:${port}`);
if (new URL(origin).hostname !== host || new URL(origin).port !== String(port)) throw new Error('Startup check requires its own local fixture origin.');
const dist = validateDistDir(process.env.NEXT_DIST_DIR || '.next-e2e-monitoring-startup', { isolated: true });
const artifact = join('test-results', 'monitoring-startup', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(artifact, { recursive: true });
const restoreGuard = installNetworkGuard([origin, `http://${host}:${port + 1}`]);
const checks = [];
let child;
let error;
try {
  for (const targetPort of [port, port + 1]) {
    const reservation = createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(targetPort, host, resolve); });
    await new Promise((resolve, reject) => reservation.close(cause => cause ? reject(cause) : resolve()));
  }
  const fd = openSync(join(artifact, 'next.log'), 'a');
  child = spawn(process.execPath, ['scripts/test-tooling-sweep-server.mjs'], {
    detached: true,
    env: { ...process.env, ROO_TEST_HOST: host, BASE_URL: origin, PW_PORT: String(port), TOOLING_CONTENT_PORT: String(port + 1), NEXT_DIST_DIR: dist, ROO_ADMIN_FIXTURE: '0', TOOLING_DEV_SERVER: '0', TOOLING_API_ROUTES: '0', NEXT_PUBLIC_SENTRY_DSN: 'false' },
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  let spawnError;
  child.once('error', cause => { spawnError = cause; });
  const deadline = Date.now() + 300000;
  let healthy = false;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && !spawnError) {
    const listening = await readFile(join(artifact, 'next.log'), 'utf8').then(log => log.includes('Ready in')).catch(() => false);
    const response = listening ? await fetch(origin, { signal: AbortSignal.timeout(1000) }).catch(() => null) : null;
    if (response) {
      await response.body?.cancel();
      if (response.status === 200) { healthy = true; break; }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (spawnError) throw spawnError;
  checks.push({ name: 'real Next production startup serves a normal page with malformed build-time DSN', ok: healthy });
  if (healthy) {
    const response = await fetch(`${origin}/api/client-report`, { method: 'POST', headers: { origin, 'content-type': 'application/x-sentry-envelope' }, body: '{"dsn":"false"}\n{}\n{}' });
    checks.push({ name: 'malformed DSN disables only the reporting endpoint', ok: response.status === 404, status: response.status });
    await response.body?.cancel();
  }
} catch (cause) {
  error = cause.message;
} finally {
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (cause) { if (cause.code !== 'ESRCH') error ||= cause.message; }
    if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000).unref())]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (cause) { if (cause.code !== 'ESRCH') error ||= cause.message; }
    if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000).unref())]);
    if (child.exitCode === null && child.signalCode === null) { error ||= 'Startup fixture did not exit after SIGKILL.'; child.unref(); }
    let groupEmpty = false;
    for (let i = 0; i < 20; i++) {
      try { process.kill(-child.pid, 0); } catch (cause) { if (cause.code === 'ESRCH') groupEmpty = true; else error ||= cause.message; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    checks.push({ name: 'owned framework fixture process group is empty', ok: groupEmpty });
  }
  restoreGuard();
}
const manifest = await readFile(join(dist, 'tooling-build.json'), 'utf8').then(JSON.parse).catch(() => null);
const buildId = await readFile(join(dist, 'BUILD_ID'), 'utf8').then(value => value.trim()).catch(() => null);
checks.push({ name: 'production build has a source fingerprint and build identity', ok: Boolean(buildId && manifest?.version === 1 && manifest.sourceHash && manifest.baseURL === origin && manifest.contentURL === `http://${host}:${port + 1}`) });
const ok = !error && checks.length === 4 && checks.every(check => check.ok);
await writeFile(join(artifact, 'report.json'), JSON.stringify({ ok, error, checks, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHash: manifest?.sourceHash, buildId, config: 'malformed DSN false', origin }, null, 2));
console.log(`report: ${join(artifact, 'report.json')}`);
process.exitCode = ok ? 0 : 1;
