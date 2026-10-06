import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { createSweepPostgresFixture, root } from './sweep-postgres-fixture.mjs';
import { installNetworkGuard } from './test-target-safety.mjs';

export const storageRelease = { tag: 'v1.79.33', commit: '2379ad5493f06bcf3bb5f044b844e292b98df4a0' };
const host = '127.0.0.1';
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const reservePort = async () => {
  const server = net.createServer();
  server.listen(0, host);
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
const jwt = (secret, role) => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ role, iss: 'roo-local-fixture', iat: now, exp: now + 3600 })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
};
const terminate = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  } finally { clearTimeout(timer); }
};

export async function start({ storageSource = '/tmp/roo-storage-api-v1.79.33', pgBin = '/tmp/roo-request-pg17/runtime/usr/lib/postgresql/17/bin', postgrestBin = '/tmp/roo-request-postgrest/postgrest', libraryPath = '/tmp/roo-request-pg17/runtime/usr/lib/x86_64-linux-gnu', signedUploadExpirationSeconds = 120, commerceRepairMigration = true, fullMigrationChain = false, afterMigrations, additionalOrigins = [] } = {}) {
  assert.equal(process.env.ROO_TEST_HOST || host, host, 'Storage fixture is an internal loopback-only stack');
  assert.equal(process.env.ROO_TEST_POSTGRES_HOST || host, host);
  assert.ok(Number.isSafeInteger(signedUploadExpirationSeconds) && signedUploadExpirationSeconds > 0 && signedUploadExpirationSeconds <= 7200);
  storageSource = fs.realpathSync(storageSource);
  assert.ok(storageSource.startsWith('/tmp/roo-storage-api-'), 'Official Storage build must be task-owned under /tmp');
  const revision = spawnSync('git', ['-C', storageSource, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(revision.status, 0, 'Storage source revision is unavailable');
  assert.equal(revision.stdout.trim(), storageRelease.commit, 'Storage source does not match pinned official release');
  assert.ok(fs.existsSync(path.join(storageSource, 'dist/start/server.js')), 'Build the pinned Storage checkout first (see roo-sanity-env.md)');
  assert.ok(fs.existsSync(path.join(storageSource, 'migrations/tenant/0073-revoke-grants-to-unused-operations.sql')), 'Pinned Storage migrations are unavailable');
  const storagePort = await reservePort();
  const gatewayPort = await reservePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'roo-storage-fixture-'));
  const storageUrl = `http://${host}:${storagePort}`;
  const supabaseUrl = `http://${host}:${gatewayPort}`;
  const filePath = path.join(scratch, 'files');
  const storageLog = path.join(scratch, 'storage.log');
  let database, storageProcess, gateway, restoreGuard, failedDatabaseScratch;
  let serviceRoleKey, anonKey;
  const cleanup = { storagePid: null, postgresPid: null, postgrestPid: null, databaseScratch: null, storageScratch: scratch, stopped: false };
  let stopping;
  const stop = () => stopping ||= (async () => {
    if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); gateway = null; }
    await terminate(storageProcess);
    if (database) await database.stop();
    restoreGuard?.();
    const databaseScratch = database?.scratch || failedDatabaseScratch;
    if (databaseScratch) fs.rmSync(databaseScratch, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
    return { ...cleanup, stopped: true, storageExited: !cleanup.storagePid || !isAlive(cleanup.storagePid), postgresExited: !cleanup.postgresPid || !isAlive(cleanup.postgresPid), postgrestExited: !cleanup.postgrestPid || !isAlive(cleanup.postgrestPid), storageScratchRemoved: !fs.existsSync(scratch), databaseScratchRemoved: !databaseScratch || !fs.existsSync(databaseScratch) };
  })();
  try {
    fs.mkdirSync(filePath);
    fs.symlinkSync(path.join(storageSource, 'migrations'), path.join(scratch, 'migrations'));
    database = await createSweepPostgresFixture({ pgBin, postgrestBin, libraryPath, commerceRepairMigration, fullMigrationChain, beforeMigrations: async context => {
      cleanup.postgresPid = Number(fs.readFileSync(path.join(context.scratch, 'data/postmaster.pid'), 'utf8').split('\n')[0]);
      cleanup.databaseScratch = context.scratch;
      serviceRoleKey = jwt(context.jwtSecret, 'service_role');
      anonKey = jwt(context.jwtSecret, 'anon');
      const logFd = fs.openSync(storageLog, 'a', 0o600);
      const childEnv = {
        PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, NODE_ENV: 'test',
        ROO_TEST_NETWORK_ORIGINS: JSON.stringify([storageUrl, supabaseUrl, `http://${host}:${context.restPort}`]),
        DATABASE_URL: context.databaseUrl, DATABASE_POOL_URL: context.databaseUrl,
        AUTH_JWT_SECRET: context.jwtSecret, PGRST_JWT_SECRET: context.jwtSecret,
        AUTH_JWT_ALGORITHM: 'HS256', SERVICE_KEY: serviceRoleKey, ANON_KEY: anonKey,
        AUTH_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
        SERVER_HOST: host, SERVER_PORT: String(storagePort), TENANT_ID: 'roo-storage-fixture',
        STORAGE_BACKEND: 'file', FILE_STORAGE_BACKEND_PATH: filePath, STORAGE_S3_BUCKET: 'roo-local-files',
        FILE_SIZE_LIMIT: '2147483648', FILE_SIZE_LIMIT_STANDARD_UPLOAD: '2147483648',
        UPLOAD_SIGNED_URL_EXPIRATION_TIME: String(signedUploadExpirationSeconds),
        DB_INSTALL_ROLES: 'true', DB_SUPER_USER: os.userInfo().username,
        PG_QUEUE_ENABLE: 'false', S3_PROTOCOL_ENABLED: 'false', MULTI_TENANT: 'false',
        EXPOSE_DOCS: 'false', LOGFLARE_ENABLED: 'false', TRACING_ENABLED: 'false',
        VECTOR_ENABLED: 'false', VECTOR_STORE_MIGRATIONS_ENABLED: 'false',
        TUS_URL_PATH: '/upload/resumable', TUS_LOCK_TYPE: 'postgres',
        STORAGE_PUBLIC_URL: supabaseUrl, REQUEST_ALLOW_X_FORWARDED_PATH: 'true',
        VERSION: storageRelease.tag,
      };
      storageProcess = spawn(process.execPath, [path.join(storageSource, 'dist/start/server.js')], { cwd: scratch, env: childEnv, stdio: ['ignore', logFd, logFd] });
      fs.closeSync(logFd);
      cleanup.storagePid = storageProcess.pid;
      for (let attempt = 0; attempt < 300; attempt++) {
        assert.equal(storageProcess.exitCode, null, fs.readFileSync(storageLog, 'utf8').replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted-jwt]'));
        try {
          const response = await fetch(`${storageUrl}/status`, { signal: AbortSignal.timeout(500) });
          if (response.status === 200) return;
        } catch {}
        if (attempt === 299) throw new Error('Official Storage readiness deadline exceeded');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }});
    cleanup.databaseScratch = database.scratch;
    cleanup.postgrestPid = database.postgrestPid;
    restoreGuard = installNetworkGuard([supabaseUrl, storageUrl, database.postgrestUrl, database.origin, ...additionalOrigins]);
    if (!fullMigrationChain) await database.apply('20260710214023_support_private_file_assets.sql');
    if (afterMigrations) await afterMigrations(database);
    const storageMigrations = await database.sql`select id,name,hash from storage.migrations order by id`;
    assert.equal(storageMigrations.at(-1).id, 73, 'Pinned official Storage schema is incomplete');
    gateway = http.createServer((request, response) => {
      const storage = request.url.startsWith('/storage/v1/');
      const rest = request.url.startsWith('/rest/v1/');
      const auth = request.url.startsWith('/auth/v1/');
      if (!storage && !rest && !auth) { response.writeHead(404); response.end(); return; }
      const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-length, content-range, etag, location, upload-offset, upload-length, tus-resumable' };
      if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
        response.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS', 'access-control-allow-headers': request.headers['access-control-request-headers'] || '*', 'access-control-max-age': '3600' });
        response.end();
        return;
      }
      const destination = storage ? storageUrl : database.origin;
      const pathname = storage ? request.url.slice(11) : request.url;
      const headers = { ...request.headers, host: new URL(destination).host };
      if (storage) { headers['x-forwarded-prefix'] = '/storage/v1'; headers['x-forwarded-host'] = new URL(supabaseUrl).host; headers['x-forwarded-proto'] = 'http'; }
      const upstream = http.request(destination + pathname, { method: request.method, headers }, result => {
        response.writeHead(result.statusCode, { ...result.headers, ...cors });
        result.on('error', error => response.destroy(error));
        result.pipe(response);
      });
      upstream.setTimeout(30000, () => upstream.destroy(new Error('Fixture upstream timeout')));
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.on('aborted', () => upstream.destroy());
      response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
      request.pipe(upstream);
    });
    gateway.listen(gatewayPort, host);
    await once(gateway, 'listening');
    const client = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
    return { ...database, start, stop, client, origin: supabaseUrl, token: serviceRoleKey, supabaseUrl, baseUrl: supabaseUrl, postgrestUrl: database.postgrestUrl, storageUrl, serviceRoleKey, anonKey, scratch, databaseScratch: database.scratch, storageMigrations, versions: { postgres: database.postgresVersion, postgrest: database.postgrestVersion, storage: storageRelease, node: process.version, supabaseJs: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@supabase/supabase-js/package.json'), 'utf8')).version }, ports: { postgres: database.pgPort, postgrest: database.restPort, storage: storagePort, gateway: gatewayPort } };
  } catch (error) {
    failedDatabaseScratch = error.scratch;
    if (fs.existsSync(storageLog)) error.storageLog = fs.readFileSync(storageLog, 'utf8').replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted-jwt]');
    error.cleanup = await stop();
    throw error;
  }
}
