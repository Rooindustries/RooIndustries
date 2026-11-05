import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installNetworkGuard, localOrigin, refuseEnvFiles, validateDistDir } from './lib/test-target-safety.mjs';
import { portFromEnv } from './lib/free-tcp-port.mjs';
import { startChildOnPorts, stopChild } from './lib/start-on-port.mjs';

refuseEnvFiles();
const host = process.env.ROO_TEST_HOST || '127.0.0.1';
const requestedOrigin = process.env.BASE_URL && new URL(localOrigin(process.env.BASE_URL));
const requestedPort = portFromEnv('PW_PORT') || Number(requestedOrigin?.port || 0);
const distBase = validateDistDir(process.env.NEXT_DIST_DIR || `.next-e2e-monitoring-startup-${host.replace(/[^a-zA-Z0-9]/g, '-')}`, { isolated: true });
const artifact = join('test-results', 'monitoring-startup', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(artifact, { recursive: true });
const checks = [];
let child, error, origin, port, contentPort, dist, log, restoreGuard;
let launched, stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true;
  if (launched) stopChild(launched);
});
const output = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
try {
  let healthy = false;
  try {
    ({ child } = await startChildOnPorts({
      host,
      requested: [requestedPort, 0],
      preferred: [3459, 3460],
      passHeld: true,
      timeout: 300000,
      output,
      isReady: async () => {
        if (!output().includes('Ready in')) return false;
        const response = await fetch(origin, { signal: AbortSignal.timeout(1000) }).catch(() => null);
        await response?.body?.cancel();
        return response?.status === 200;
      },
      spawnChild: ([candidate, content], launch) => {
        if (stopping) throw new Error('Startup check was stopped.');
        [port, contentPort] = [candidate, content];
        origin = localOrigin(process.env.BASE_URL || `http://${host}:${port}`);
        if (new URL(origin).hostname !== host || new URL(origin).port !== String(port)) throw new Error('Startup check requires its own local fixture origin.');
        dist = validateDistDir(`${distBase}-${port}`, { isolated: true });
        restoreGuard?.();
        restoreGuard = installNetworkGuard([origin, `http://${host}:${contentPort}`]);
        log = join(artifact, `next-${port}.log`);
        const fd = openSync(log, 'a');
        try {
          return launched = launch.spawn(process.execPath, ['scripts/test-tooling-sweep-server.mjs'], {
            env: { ...process.env, ROO_TEST_HOST: host, BASE_URL: origin, PW_PORT: String(port), TOOLING_CONTENT_PORT: String(contentPort), NEXT_DIST_DIR: dist, ROO_ADMIN_FIXTURE: '0', TOOLING_DEV_SERVER: '0', TOOLING_API_ROUTES: '0', TOOLING_MONITORING_STARTUP: '1', SENTRY_CLI_NO_TELEMETRY: '1', NEXT_PUBLIC_SENTRY_DSN: 'false' },
            stdio: ['ignore', fd, fd],
          });
        } finally {
          closeSync(fd);
        }
      },
    }));
    healthy = true;
  } catch (cause) {
    error = cause.message;
  }
  checks.push({ name: 'real Next production startup serves a normal page with malformed build-time DSN', ok: healthy });
  if (healthy) {
    const response = await fetch(`${origin}/api/client-report`, { method: 'POST', headers: { origin, 'content-type': 'application/x-sentry-envelope' }, body: '{"dsn":"false"}\n{}\n{}' });
    checks.push({ name: 'malformed DSN disables only the reporting endpoint', ok: response.status === 404, status: response.status });
    await response.body?.cancel();
  }
} catch (cause) {
  error ||= cause.message;
} finally {
  if (child?.pid) {
    await stopChild(child);
    let groupEmpty = false;
    for (let i = 0; i < 20; i++) {
      try { process.kill(-child.pid, 0); } catch (cause) { if (cause.code === 'ESRCH') groupEmpty = true; else error ||= cause.message; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    checks.push({ name: 'owned framework fixture process group is empty', ok: groupEmpty });
  }
  restoreGuard?.();
}
const manifest = await readFile(join(dist || distBase, 'tooling-build.json'), 'utf8').then(JSON.parse).catch(() => null);
const buildId = await readFile(join(dist || distBase, 'BUILD_ID'), 'utf8').then(value => value.trim()).catch(() => null);
const buildConfig = await readFile(join(dist || distBase, 'required-server-files.json'), 'utf8').then(JSON.parse).catch(() => null);
const reportingEnabled = buildConfig?.config?.env?.NEXT_PUBLIC_ROO_SENTRY_ENABLED;
checks.push({ name: 'malformed DSN is exercised inside the production reporting gate', ok: reportingEnabled === '1', actual: reportingEnabled, expected: '1' });
checks.push({ name: 'production build has a source fingerprint and build identity', ok: Boolean(buildId && manifest?.version === 1 && manifest.sourceHash && manifest.baseURL === origin && manifest.contentURL === `http://${host}:${contentPort}`) });
const ok = !error && checks.length === 5 && checks.every(check => check.ok);
await writeFile(join(artifact, 'report.json'), JSON.stringify({ ok, error, checks, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHash: manifest?.sourceHash, buildId, config: 'malformed DSN false', origin }, null, 2));
console.log(`report: ${join(artifact, 'report.json')}`);
process.exitCode = ok ? 0 : 1;
