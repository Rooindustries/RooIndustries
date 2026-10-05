import fs from 'node:fs';
import path from 'node:path';

export function uiFinishFixture({ json, read, base }) {
  let state = { active: false, scenario: '', calls: [], released: [], holdPath: '', status: 'booked' };
  const pending = new Map();
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const session = (principal, lifetime = 3600) => {
    const now = Math.floor(Date.now() / 1000);
    const id = `00000000-0000-4000-8000-0000000000${{ A: '11', B: '12', C: '13' }[principal]}`;
    const claims = { sub: id, session_id: `finish-session-${principal}`, iat: now, exp: now + lifetime, amr: [{ method: 'otp', timestamp: now }], aud: 'authenticated', role: 'authenticated' };
    return { access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.${encode('synthetic')}`, refresh_token: `finish-refresh-${principal}`, token_type: 'bearer', expires_in: lifetime, expires_at: claims.exp, user: { id, aud: 'authenticated', role: 'authenticated', email: `finish-${principal}@fixture.invalid`, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
  };
  const hold = { slotHoldId: 'hold-finish-A-refreshed', slotHoldToken: 'hold-finish-A-refreshed-token', slotHoldExpiresAt: '2099-01-05T05:30:00.000Z' };
  return {
    async handle(req, res, url) {
      const p = url.pathname;
      if (p === '/__ui/finish') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Roo UI finish scenarios</title><pre id="results" hidden></pre><iframe id="app" title="Actual application" style="position:fixed;inset:0;width:100%;height:100vh;border:0"></iframe><script type="module" src="/__ui/finish-runner.js"></script>'); return true; }
      if (p === '/__ui/finish-runner.js' || p === '/__ui/finish-timing.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(p.endsWith('timing.js') ? 'tests/fixtures/ui-finish-timing.js' : 'tests/fixtures/ui-finish-browser.mjs')); return true; }
      if (p === '/__ui/finish-control') {
        if (req.method === 'POST') { const body = await read(req); state = { active: true, scenario: body.scenario, calls: [], released: [], holdPath: body.holdPath || '', holdPrincipal: body.holdPrincipal || 'A', status: body.status || 'booked', finalizeStatus: body.finalizeStatus || '', holdBody: Boolean(body.holdBody), passwordPending: Number(body.passwordPending || 0), initialBExpiry: Number(body.initialBExpiry || 3600), refreshFailure: Boolean(body.refreshFailure) }; }
        if (req.method === 'PATCH') { const body = await read(req); state.holdPath = body.holdPath || ''; state.holdPrincipal = body.holdPrincipal || 'A'; state.holdBody = Boolean(body.holdBody); }
        json(res, { ...state, A: session('A'), B: session('B', state.initialBExpiry), C: session('C'), pending: [...pending.keys()] }); return true;
      }
      if (p === '/__ui/finish-release') {
        const key = url.searchParams.get('key'); const entry = pending.get(key);
        if (entry) { pending.delete(key); state.released.push({ key, destroyed: entry.res.destroyed, time: Date.now() }); if (entry.finishBody) entry.res.end(JSON.stringify(entry.body)); else json(entry.res, entry.body); }
        json(res, { released: Boolean(entry), destroyed: entry?.res.destroyed }); return true;
      }
      if (p === '/__ui/finish-evidence') {
        const body = await read(req); const name = String(body.scenario).replace(/[^a-z0-9-]/g, ''); const phase = body.phase === 'before' ? 'before' : 'after';
        const artifact = path.resolve(`test-results/ui-finish-${phase}-${name}.json`); fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, JSON.stringify(body, null, 2)); json(res, { saved: artifact }); return true;
      }
      if (p === '/__ui/repairs' || p === '/__ui') { state.active = false; return false; }
      if (!state.active) return false;
      if (p === '/api/ref/recoverPassword' && state.passwordPending > 0) {
        const body = await read(req); state.calls.push({ path: p, method: req.method, body, time: Date.now() }); state.passwordPending -= 1;
        json(res, { ok: true, status: 'pending', message: 'Synthetic password save pending.' }, 202); return true;
      }
      if (p.startsWith('/auth/v1/')) {
        const body = req.method === 'POST' ? await read(req) : {};
        let principal = ['A', 'B', 'C'].find(value => body.auth_code === `finish-code-${value}` || body.token_hash === `finish-hash-${value}` || body.refresh_token === `finish-refresh-${value}`) || 'B';
        try { if (req.headers.authorization) { const claims = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64url')); principal = claims.sub.endsWith('11') ? 'A' : claims.sub.endsWith('13') ? 'C' : 'B'; } } catch {}
        const reply = p.endsWith('/user') ? session(principal).user : session(principal);
        const call = { path: p, method: req.method, principal, grant: url.searchParams.get('grant_type'), code: body.auth_code || '', tokenHash: body.token_hash || '', time: Date.now() };
        state.calls.push(call);
        res.on('finish', () => { call.finished = true; call.finishedAt = Date.now(); });
        res.on('close', () => { call.closed = true; call.closedAt = Date.now(); call.aborted = !res.writableFinished; call.socketDestroyed = req.socket.destroyed; });
        if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token' && state.refreshFailure) { json(res, { msg: 'Invalid refresh token.', error_code: 'refresh_token_not_found' }, 400); return true; }
        const key = `auth-${principal}`;
        if (principal === state.holdPrincipal && p === state.holdPath && !pending.has(key)) {
          call.held = true; call.holdBody = state.holdBody;
          if (state.holdBody) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.flushHeaders(); call.headersFlushedAt = Date.now(); }
          pending.set(key, { res, body: reply, finishBody: state.holdBody }); return true;
        }
        json(res, reply); return true;
      }
      if (!['/api/payment/start', '/api/payment/status', '/api/payment/finalize', '/api/payment/cancel'].includes(p)) return false;
      const body = await read(req); const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      state.calls.push({ path: p, method: req.method, token, body, time: Date.now() });
      const reply = p.endsWith('/cancel') ? { ok: true, cancelled: true, refreshedHold: hold } : p.endsWith('/start') ? { ok: true, paymentAccessToken: 'payment-finish-A', status: state.status, providerPayload: { checkoutUrl: `${base}/__ui/hosted/checkout` }, refreshedHold: hold, bookingId: 'receipt-finish-A', emailDispatchToken: 'receipt-finish-A-token' } : { ok: true, status: state.status, bookingId: 'receipt-finish-A', emailDispatchToken: 'receipt-finish-A-token' };
      if (p.endsWith('/finalize') && state.finalizeStatus) reply.status = state.finalizeStatus;
      if (p === state.holdPath && (!token || token === 'payment-finish-A')) { pending.set('payment-A', { res, body: reply }); return true; }
      json(res, reply); return true;
    }
  };
}
