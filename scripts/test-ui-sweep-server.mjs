const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { uiRepairsFixture } from '../tests/fixtures/ui-repairs-server.mjs';
import { uiFinishFixture } from '../tests/fixtures/ui-finish-server.mjs';
import { installNetworkGuard, localOrigin, refuseEnvFiles, validateDistDir } from './lib/test-target-safety.mjs';

refuseEnvFiles();
const host = testHost;
const port = Number(process.env.UI_PORT || 45981);
const nextPort = Number(process.env.UI_NEXT_PORT || 45980);
if (![port, nextPort].every(value => Number.isInteger(value) && value > 1024 && value < 65536) || port === nextPort) throw new Error('Invalid fixture ports.');
const base = localOrigin(`http://${host}:${port}`);
const upstream = localOrigin(`http://${host}:${nextPort}`);
installNetworkGuard([base, upstream]);
const dist = validateDistDir(process.env.NEXT_DIST_DIR || '.next-e2e-ui-sweep', { isolated: true });
const artifact = path.resolve(process.env.UI_ARTIFACT || 'test-results/ui-sweep.json');
let state = { scenario: '', mode: 'valid', calls: [] };
let pendingOld;
const userId = '00000000-0000-4000-8000-000000000001';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const makeSession = () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: userId, session_id: 'ui-recovery-session', iat: now, exp: now + 3600, amr: [{ method: 'otp', timestamp: now }], aud: 'authenticated', role: 'authenticated' };
  if (state.mode === 'pkce-recovery') claims.amr = [{ method: 'recovery', timestamp: now }];
  if (state.mode === 'old-otp') claims.amr = [{ method: 'otp', timestamp: now - 7201 }];
  if (state.mode === 'ordinary') claims.amr = [{ method: 'password', timestamp: now }];
  if (state.mode === 'stale') claims.iat = now - 7201;
  if (state.mode === 'future') claims.iat = now + 120;
  if (state.mode === 'expired') claims.exp = now - 1;
  if (state.mode === 'switched') { claims.sub = '00000000-0000-4000-8000-000000000002'; claims.session_id = 'other-recovery-session'; }
  if (state.mode === 'mismatched') claims.sub = '00000000-0000-4000-8000-000000000002';
  return { access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.${Buffer.from('synthetic-signature').toString('base64url')}`, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600, expires_at: claims.exp, user: { id: state.mode === 'switched' ? claims.sub : userId, aud: 'authenticated', role: 'authenticated', email: 'ui@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
};
const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; form-action 'self'; base-uri 'self'";
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const read = async req => { let body = ''; for await (const part of req) { body += part; if (body.length > 131072) throw new Error('Fixture body too large.'); } return body ? JSON.parse(body) : {}; };
const repairs = uiRepairsFixture({ json, read, base });
const finish = uiFinishFixture({ json, read, base });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base);
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (await finish.handle(req, res, url)) return;
    if (await repairs.handle(req, res, url)) return;
    if (url.pathname === '/__ui/release-old') {
      if (pendingOld) { json(pendingOld, { ok: true, reason: 'reserved' }); pendingOld = null; }
      return json(res, { released: true });
    }
    if (url.pathname === '/__ui/control') {
      if (req.method === 'POST') { const value = await read(req); state = { scenario: String(value.scenario || ''), mode: String(value.mode || 'valid'), calls: [] }; }
      return json(res, { ...state, session: makeSession() });
    }
    if (url.pathname === '/__ui/evidence' && req.method === 'POST') {
      const body = await read(req); fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, JSON.stringify(body, null, 2)); return json(res, { saved: artifact });
    }
    if (url.pathname === '/__ui') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Roo UI isolated scenarios</title><main><h1>UI scenarios</h1><pre id="results"></pre><iframe id="app" title="Actual application" style="width:100%;height:850px;border:0"></iframe></main><script type="module" src="/__ui/runner.js"></script>'); }
    if (url.pathname === '/__ui/runner.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('tests/fixtures/ui-sweep-browser.mjs')); }
    if (url.pathname === '/__ui/productionBrowser.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('src/lib/productionBrowser.js', 'utf8')); }
    if (url.pathname.startsWith('/auth/v1/')) {
      const body = await read(req); state.calls.push({ path: url.pathname, grant: url.searchParams.get('grant_type'), type: body.type || '', code: body.auth_code || '' });
      if (state.mode === 'invalid') return json(res, { msg: 'Invalid recovery', error_code: 'otp_expired' }, 401);
      if (url.pathname.endsWith('/user')) return json(res, makeSession().user);
      if (url.pathname.endsWith('/token') || url.pathname.endsWith('/verify')) return json(res, makeSession());
      return json(res, {});
    }
    if (url.pathname === '/api/ref/validateReferral') {
      const code = url.searchParams.get('code'); state.calls.push({ path: url.pathname, code });
      if (code === 'oldslug') { pendingOld = res; return; }
      return json(res, { ok: false, reason: 'available' });
    }
    if (url.pathname === '/api/ref/reset' || url.pathname === '/api/ref/recoverPassword') {
      const body = await read(req); state.calls.push({ path: url.pathname, legacy: Boolean(body.token), staleLegacy: body.token === 'e'.repeat(64), passwordProvided: Boolean(body.password), expectedUserId: body.expectedUserId, expectedSessionId: body.expectedSessionId });
      if (state.mode === 'pending-switch') {
        state.mode = 'switched';
        res.setHeader('Set-Cookie', `sb-100-auth-token=base64-${encode(makeSession())}; Path=/; SameSite=Lax`);
        return json(res, { ok: true, status: 'pending' }, 202);
      }
      if (body.token === 'e'.repeat(64)) return json(res, { ok: false, error: 'Invalid or expired token.' }, 400);
      return json(res, { ok: true, status: 'updated' });
    }
    if (url.pathname.startsWith('/api/content/')) return json(res, { ok: true, data: ['global', 'global-content'].includes(url.pathname.split('/').pop()) ? {} : [] });
    if (url.pathname === '/api/bookingAvailability') return json(res, { ok: true, slots: [], availableSlots: [] });
    if (url.pathname.startsWith('/api/')) return json(res, { ok: false, error: 'Synthetic UI fixture refuses this endpoint.' }, 503);
    const proxy = http.request(`${upstream}${req.url}`, { method: req.method, headers: { ...req.headers, 'accept-encoding': 'identity', host: `${host}:${nextPort}` } }, response => {
      const headers = { ...response.headers, 'content-security-policy': csp, 'x-frame-options': 'SAMEORIGIN' };
      if (headers.location) {
        const target = new URL(headers.location, base);
        if (target.origin === upstream) headers.location = `${base}${target.pathname}${target.search}${target.hash}`;
        else if (target.origin !== base) { response.resume(); return json(res, { error: 'Synthetic UI fixture refuses external redirects.' }, 503); }
      }
      if (repairs.active() && String(headers['content-type']).includes('text/html')) {
        delete headers['content-length'];
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => { const html = Buffer.concat(chunks).toString(); const homeHtml = url.pathname === '/' && req.headers['x-roo-cta-preserve-home-ssr'] === '1' ? html : repairs.transform(html); res.writeHead(response.statusCode, headers); res.end(homeHtml.replace('<head>', `<head><script>window.__uiRepairsConfig=${repairs.bootstrap()}</script><script src="/__ui/repairs-init.js"></script>`)); });
      } else { res.writeHead(response.statusCode, headers); response.pipe(res); }
    });
    proxy.on('error', () => json(res, { error: 'Isolated Next server is starting.' }, 503)); req.pipe(proxy);
  } catch (error) { json(res, { error: error.message }, 500); }
});
await new Promise(resolve => server.listen(port, host, resolve));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', TZ: 'UTC', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: dist, BASE_URL: base, ROO_TEST_HOST: testHost, TOOLING_NETWORK_GUARD: '1', NODE_OPTIONS: `--import=${path.resolve('scripts/lib/test-target-safety.mjs')}`, NEXT_PUBLIC_SUPABASE_URL: base, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-ui-publishable-key', NEXT_PUBLIC_SUPABASE_ASSET_URL: base, DATA_PRIMARY_BACKEND: 'supabase', SALES_PREVIEW_READ_ONLY: '1' };
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', host, '--port', String(nextPort)], { env, stdio: 'inherit' });
child.on('exit', code => { server.close(); process.exitCode = code || 0; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal); server.close(); });
console.log(JSON.stringify({ pid: process.pid, nextPid: child.pid, url: base, runner: `${base}/__ui`, artifact, isolatedHttpFixtures: true, browserCsp: csp }));
