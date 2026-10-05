const frame = document.getElementById('app');
const params = new URLSearchParams(location.search);
const requested = params.get('scenario') || 'all';
const phase = params.get('phase') || 'after';
const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const wait = async (fn, message, ms = 8000) => { const start = Date.now(); while (Date.now() - start < ms) { const value = await fn(); if (value) return value; await delay(50); } throw new Error(message); };
const doc = () => frame.contentDocument;
const win = () => frame.contentWindow;
const text = () => doc()?.body?.innerText || '';
const json = async (url, value) => (await fetch(url, value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {})).json();
const saveEvidence = async value => { const saved = await json('/__ui/finish-evidence', value); if (!saved.saved) throw new Error('Scenario evidence was not saved.'); return saved.saved; };
const saveIndex = complete => saveEvidence({ scenario: `${requested}-index`, phase, complete, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results: results.map(r => ({ name: r.name, ok: r.ok, error: r.error, artifact: r.artifact })) });
const control = value => json('/__ui/finish-control', value);
const release = key => json(`/__ui/finish-release?key=${key}`);
const input = (selector, value) => { const node = doc().querySelector(selector); assert(node, `Missing ${selector}`); Object.getOwnPropertyDescriptor(win().HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new (win().Event)('input', { bubbles: true })); };
const button = label => [...doc().querySelectorAll('button')].find(node => node.textContent.trim().startsWith(label));
const click = async label => { const node = await wait(() => button(label), `Missing ${label}`); node.click(); await delay(70); };
const route = (url, state) => { win().history.pushState({ ...win().history.state, __rooLegacy: true, usr: state }, '', url); win().dispatchEvent(new (win().PopStateEvent)('popstate', { state: win().history.state })); };
const submit = () => doc().querySelector('form').dispatchEvent(new (win().Event)('submit', { bubbles: true, cancelable: true }));
const storage = key => JSON.parse(sessionStorage.getItem(key) || 'null');
const cookieSession = () => {
  const parts = doc().cookie.split(';').map(value => value.trim()).filter(value => /^sb-100-auth-token(?:\.\d+)?=/.test(value)).sort();
  const value = decodeURIComponent(parts.map(part => part.slice(part.indexOf('=') + 1)).join(''));
  try { return JSON.parse(value.startsWith('base64-') ? atob(value.slice(7).replace(/-/g, '+').replace(/_/g, '/')) : value); } catch { return null; }
};
const snapshot = () => ({ href: win().location.href, marker: storage('referral_recovery_session'), authSession: cookieSession(), session: storage('payment_session_state'), checkout: storage('checkout_booking_state'), hold: storage('my_slot_hold'), confirmation: storage('booking_confirmation_state'), draft: storage('booking_form_draft'), text: text().slice(-1800), errors: win().__uiErrors || [] });
const load = async (url, options) => {
  frame.src = 'about:blank'; await wait(() => doc()?.URL === 'about:blank', 'Previous frame did not leave'); sessionStorage.clear(); localStorage.clear();
  for (const cookie of document.cookie.split(';')) document.cookie = `${cookie.split('=')[0].trim()}=; Max-Age=0; Path=/`;
  await json('/__ui/repairs-control', { scenario: requested, ...options }); const cfg = await control({ scenario: requested, ...options });
  if (options?.verifier) document.cookie = `sb-100-auth-token-code-verifier=${encodeURIComponent(JSON.stringify('finish-verifier/recovery'))}; Path=/; SameSite=Lax`;
  frame.src = typeof url === 'function' ? url(cfg) : url;
  await wait(() => doc()?.querySelector('main'), 'Actual application absent'); return cfg;
};
const run = async (name, action) => {
  if (requested !== 'all' && requested !== name && !name.startsWith(`${requested}-`)) return;
  let evidence = {};
  try { await action(evidence); results.push({ name, ok: true, ...evidence }); }
  catch (error) { results.push({ name, ok: false, error: error.message, ...evidence, failedAt: Date.now(), final: snapshot(), http: await control() }); }
  if (window.__captureUiRecoveryCheckpoint) await window.__captureUiRecoveryCheckpoint(name, phase);
  await fetch('/__ui/finish-control', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  await release('auth-A'); await release('auth-B'); await release('auth-C'); await release('payment-A');
  results.at(-1).artifact = await saveEvidence({ scenario: name, phase, complete: true, results: [results.at(-1)] });
  await saveIndex(false);
};
const implicit = session => `/referrals/reset#type=recovery&access_token=${session.access_token}&refresh_token=${session.refresh_token}`;
for (const kind of ['implicit', 'code', 'token-hash']) await run(`recovery-current-${kind}`, async evidence => {
  const cfg = await load(cfg => kind === 'implicit' ? implicit(cfg.B) : kind === 'code' ? '/referrals/reset?code=finish-code-B' : '/referrals/reset?type=recovery&token_hash=finish-hash-B', { verifier: kind === 'code' });
  await wait(() => doc().querySelector('#ref-reset-new-password'), 'Current recovery form unavailable');
  assert(!win().location.hash && !win().location.search, 'Current credentials restored by router');
  assert(storage('referral_recovery_session')?.sessionId === 'finish-session-B' && cookieSession()?.user?.id === cfg.B.user.id, 'Current identity/SDK cookie not bound');
  const calls = (await control()).calls; assert(calls.filter(c => c.code === 'finish-code-B' || c.tokenHash === 'finish-hash-B').length === (kind === 'implicit' ? 0 : 1), 'Current one-use exchange duplicated'); evidence.final = snapshot(); evidence.http = await control();
});
for (const kind of ['implicit', 'code', 'token-hash']) await run(`recovery-stalled-${kind}`, async evidence => {
  const cfg = await load(cfg => implicit(cfg.A), { holdPath: '/auth/v1/user' });
  await wait(async () => (await control()).pending.includes('auth-A'), 'Actual SDK A user request not held'); evidence.beforeB = snapshot();
  evidence.history = [];
  const previousReplace = win().history.replaceState.bind(win().history);
  win().history.replaceState = (...args) => { evidence.history.push({ kind: 'replace', url: args[2], ms: performance.now(), stack: new Error().stack?.split('\n').slice(1,6) }); return previousReplace(...args); };
  const previousStop = win().Event.prototype.stopImmediatePropagation;
  win().Event.prototype.stopImmediatePropagation = function () { evidence.history.push({ kind: 'stop', event: this.type, ms: performance.now() }); return previousStop.call(this); };
  const b = kind === 'implicit' ? implicit(cfg.B) : kind === 'code' ? '/referrals/reset?code=finish-code-B' : '/referrals/reset?type=recovery&token_hash=finish-hash-B';
  if (kind === 'code') doc().cookie = `sb-100-auth-token-code-verifier=${encodeURIComponent(JSON.stringify('finish-verifier/recovery'))}; Path=/; SameSite=Lax`;
  const begun = performance.now();
  if (kind === 'implicit') win().location.hash = new URL(b, location.origin).hash;
  else {
    win().History.prototype.replaceState.call(win().history, win().history.state, '', b);
    win().dispatchEvent(new (win().PopStateEvent)('popstate', { state: win().history.state }));
  }
  await delay(200); evidence.earlyB = snapshot();
  assert(!win().location.hash && !win().location.search, 'Fresh B credentials remain in URL while SDK A is pending');
  await wait(() => storage('referral_recovery_session')?.sessionId === 'finish-session-B' && doc().querySelector('#ref-reset-new-password'), 'Fresh B initialization remains blocked behind held SDK A', 3500);
  evidence.bReadyMs = Math.round(performance.now() - begun); evidence.beforeReleaseA = snapshot(); await release('auth-A'); await delay(800); evidence.afterReleaseA = snapshot();
  assert(storage('referral_recovery_session')?.sessionId === 'finish-session-B', 'Late SDK A replaced B marker');
  assert(cookieSession()?.user?.id === cfg.B.user.id, 'Late A or missing SDK cookie replaced B');
  input('#ref-reset-new-password', 'Synthetic-password1!'); input('#ref-reset-confirm-password', 'Synthetic-password1!'); submit();
  await wait(async () => (await json('/__ui/repairs-control')).calls.some(c => c.path === '/api/ref/recoverPassword'), 'Verified B cannot submit');
  const call = (await json('/__ui/repairs-control')).calls.find(c => c.path === '/api/ref/recoverPassword');
  assert(call.body.expectedUserId === cfg.B.user.id && call.body.expectedSessionId === 'finish-session-B', 'Password POST authorized stale principal/session');
  const calls = (await control()).calls; assert(calls.filter(c => c.code === 'finish-code-B' || c.tokenHash === 'finish-hash-B').length === (kind === 'implicit' ? 0 : 1), 'One-use B exchange duplicated');
  evidence.http = await control(); evidence.post = call.body; evidence.final = snapshot();
});
for (const body of [false, true]) await run(`recovery-timeout-${body ? 'body' : 'headers'}`, async evidence => {
  await load(cfg => implicit(cfg.A), { holdPath: '/auth/v1/user', holdBody: body }); await wait(async () => (await control()).pending.includes('auth-A'), 'SDK A HTTP absent');
  evidence.initial = snapshot(); assert(!win().location.hash, 'A credentials not immediately scrubbed'); const begun = performance.now();
  await wait(() => /too long|timed out/i.test(text()), 'Stalled Auth never produces useful bounded error', 17000); evidence.errorMs = Math.round(performance.now() - begun); evidence.beforeRelease = snapshot();
  await release('auth-A'); await delay(800); assert(!storage('referral_recovery_session') && !cookieSession() && !doc().querySelector('#ref-reset-new-password'), 'Late A revived timed-out recovery'); evidence.final = snapshot(); evidence.http = await control();
});
const patchControl = async value => (await fetch('/__ui/finish-control', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })).json();
const armValidation = body => patchControl({ holdPath: '/auth/v1/user', holdPrincipal: 'B', holdBody: body });
const passwordCalls = async () => [...(await control()).calls, ...(await json('/__ui/repairs-control')).calls].filter(call => call.path === '/api/ref/recoverPassword');
const startHeldSubmit = async (evidence, body) => {
  const cfg = await load(cfg => implicit(cfg.B), {});
  await wait(() => doc().querySelector('#ref-reset-new-password') && storage('referral_recovery_session')?.sessionId === 'finish-session-B', 'Initialized B form absent');
  evidence.initial = snapshot(); await armValidation(body);
  input('#ref-reset-new-password', 'Synthetic-password1!'); input('#ref-reset-confirm-password', 'Synthetic-password1!');
  evidence.submitAt = Date.now(); submit();
  await wait(async () => (await control()).pending.includes('auth-B'), 'Actual post-initialization B verification not held');
  evidence.held = snapshot(); evidence.heldHttp = await control();
  assert(evidence.heldHttp.calls.some(call => call.held && call.principal === 'B' && call.holdBody === body), 'Wrong verification boundary held');
  assert(!evidence.held.href.includes('#') && !evidence.held.href.includes('?'), 'Initialized credentials restored');
  assert((await passwordCalls()).length === 0, 'Password POST preceded held verification'); return cfg;
};
for (const body of [false, true]) await run(`recovery-submit-timeout-${body ? 'body' : 'headers'}`, async evidence => {
  const cfg = await startHeldSubmit(evidence, body);
  await wait(() => /too long|timed out/i.test(text()) && button('Update Password') && !button('Update Password').disabled, 'Submit verification never produces bounded useful error and releases loading', 17000);
  evidence.errorMs = Date.now() - evidence.submitAt; evidence.beforeRelease = snapshot(); evidence.beforeReleaseHttp = await control();
  const held = evidence.beforeReleaseHttp.calls.find(call => call.held && call.principal === 'B');
  assert(held.aborted && held.socketDestroyed && !held.finished, 'Timed-out verification HTTP was not actually aborted');
  assert(evidence.errorMs >= 14500 && evidence.errorMs < 17500, 'Submit deadline not preserved at 15 seconds');
  assert((await passwordCalls()).length === 0, 'Timed-out verification sent password POST');
  await release('auth-B'); await delay(800); evidence.final = snapshot(); evidence.http = await control();
  assert(storage('referral_recovery_session')?.sessionId === 'finish-session-B' && cookieSession()?.user?.id === cfg.B.user.id, 'Action deadline poisoned current B identity');
  assert((await passwordCalls()).length === 0 && win().location.pathname === '/referrals/reset', 'Late validation submitted or navigated B');
});
for (const body of [false, true]) await run(`recovery-submit-next-${body ? 'body' : 'headers'}`, async evidence => {
  const cfg = await startHeldSubmit(evidence, body); const begun = Date.now();
  win().location.hash = new URL(implicit(cfg.C), location.origin).hash;
  await wait(() => storage('referral_recovery_session')?.sessionId === 'finish-session-C' && doc().querySelector('#ref-reset-new-password'), 'Fresh C remains blocked behind held B verification', 3500);
  evidence.cReadyMs = Date.now() - begun; evidence.beforeRelease = snapshot(); evidence.beforeReleaseHttp = await control();
  const held = evidence.beforeReleaseHttp.calls.find(call => call.held && call.principal === 'B');
  assert(held.aborted && !held.finished && held.socketDestroyed, 'Superseded B verification HTTP was not aborted');
  assert(cookieSession()?.user?.id === cfg.C.user.id && !win().location.hash && !win().location.search, 'C cookie/scrub missing before B release');
  await release('auth-B'); await delay(800); evidence.afterRelease = snapshot();
  assert(storage('referral_recovery_session')?.sessionId === 'finish-session-C' && cookieSession()?.user?.id === cfg.C.user.id && (await passwordCalls()).length === 0, 'Late B changed C or sent B password');
  input('#ref-reset-new-password', 'Synthetic-password1!'); input('#ref-reset-confirm-password', 'Synthetic-password1!'); submit();
  await wait(async () => (await passwordCalls()).length === 1, 'Verified C cannot submit'); evidence.posts = await passwordCalls();
  assert(evidence.posts[0].body.expectedUserId === cfg.C.user.id && evidence.posts[0].body.expectedSessionId === 'finish-session-C', 'C POST authorized stale identity');
  evidence.final = snapshot(); evidence.http = await control();
});
await run('recovery-submit-retry', async evidence => {
  const cfg = await startHeldSubmit(evidence, false);
  await wait(() => /too long|timed out/i.test(text()) && button('Update Password') && !button('Update Password').disabled, 'First validation does not release retry', 17000);
  evidence.errorMs = Date.now() - evidence.submitAt; evidence.beforeRelease = snapshot(); evidence.beforeReleaseHttp = await control();
  await patchControl({}); await release('auth-B');
  submit(); await wait(async () => (await passwordCalls()).length === 1, 'Current B cannot retry after action timeout'); evidence.posts = await passwordCalls();
  assert(evidence.posts[0].body.expectedUserId === cfg.B.user.id && evidence.posts[0].body.expectedSessionId === 'finish-session-B', 'Retry POST authorized changed B identity');
  evidence.final = snapshot(); evidence.http = await control();
});
await run('recovery-submit-pending', async evidence => {
  const cfg = await load(cfg => implicit(cfg.B), { passwordPending: 2 });
  await wait(() => doc().querySelector('#ref-reset-new-password'), 'Current B form absent');
  input('#ref-reset-new-password', 'Synthetic-password1!'); input('#ref-reset-confirm-password', 'Synthetic-password1!'); evidence.submitAt = Date.now(); submit();
  await wait(async () => (await passwordCalls()).length === 3, 'Pending password requests did not retry to third attempt', 11000);
  await wait(() => /Password updated/.test(text()), 'Pending password save never completes'); evidence.posts = await passwordCalls(); evidence.http = await control(); evidence.final = snapshot(); evidence.completedMs = Date.now() - evidence.submitAt;
  assert(evidence.posts.every(call => call.body.expectedUserId === cfg.B.user.id && call.body.expectedSessionId === 'finish-session-B'), 'Pending retry lost current identity');
  assert(evidence.http.calls.filter(call => call.path === '/auth/v1/user' && call.principal === 'B').length >= 9, 'Pending attempts skipped actual SDK validation');
});
for (const body of [false, true]) await run(`recovery-refresh-retry-${body ? 'body' : 'headers'}`, async evidence => {
  const cfg = await load(cfg => implicit(cfg.B), { initialBExpiry: 4 });
  await wait(() => doc().querySelector('#ref-reset-new-password') && cookieSession()?.user?.id === cfg.B.user.id, 'Short-lived B initialization did not succeed');
  evidence.initial = snapshot();
  await wait(() => cookieSession()?.expires_at * 1000 < Date.now(), 'Initial B token did not actually expire', 6000); evidence.expired = snapshot();
  await patchControl({ holdPath: '/auth/v1/token', holdPrincipal: 'B', holdBody: body });
  input('#ref-reset-new-password', 'Synthetic-password1!'); input('#ref-reset-confirm-password', 'Synthetic-password1!'); evidence.submitAt = Date.now(); submit();
  await wait(async () => (await control()).pending.includes('auth-B'), 'Actual expired B SDK refresh not held'); evidence.heldHttp = await control();
  await wait(() => /too long|timed out/i.test(text()) && button('Update Password') && !button('Update Password').disabled, 'Refresh deadline did not release loading', 17000);
  evidence.errorMs = Date.now() - evidence.submitAt; evidence.beforeRelease = snapshot(); evidence.beforeReleaseHttp = await control();
  const held = evidence.beforeReleaseHttp.calls.find(call => call.held);
  assert(held.path === '/auth/v1/token' && held.grant === 'refresh_token' && held.holdBody === body && held.aborted && held.socketDestroyed && !held.finished, 'Wrong refresh or no real HTTP abort');
  assert(cookieSession()?.refresh_token === cfg.B.refresh_token && storage('referral_recovery_session')?.sessionId === 'finish-session-B', 'Locally cancelled refresh erased otherwise-retryable B cookie/marker');
  assert((await passwordCalls()).length === 0, 'Cancelled refresh sent a password POST');
  await patchControl({}); await release('auth-B'); await delay(800); evidence.afterRelease = snapshot();
  assert(cookieSession()?.refresh_token === cfg.B.refresh_token && (await passwordCalls()).length === 0, 'Late refresh changed retained B or posted password');
  submit(); await wait(async () => (await passwordCalls()).length === 1, 'Retained expired B cannot retry refresh and password validation'); evidence.posts = await passwordCalls(); evidence.http = await control(); evidence.final = snapshot();
  assert(evidence.posts[0].body.expectedUserId === cfg.B.user.id && evidence.posts[0].body.expectedSessionId === 'finish-session-B', 'Refreshed retry authorized stale identity');
  assert(evidence.http.calls.filter(call => call.path === '/auth/v1/token' && call.principal === 'B' && call.grant === 'refresh_token').length === 2, 'Retry did not perform exactly one fresh SDK refresh');
});
await run('recovery-refresh-rejected', async evidence => {
  await load(cfg => implicit(cfg.B), { initialBExpiry: 4, refreshFailure: true });
  await wait(() => doc().querySelector('#ref-reset-new-password') && cookieSession(), 'B initialization absent before provider rejection'); evidence.initial = snapshot();
  await wait(() => cookieSession()?.expires_at * 1000 < Date.now(), 'B expiry absent', 6000);
  input('#ref-reset-new-password', 'Synthetic-password1!'); input('#ref-reset-confirm-password', 'Synthetic-password1!'); submit();
  await wait(() => /changed or expired/.test(text()) && !cookieSession() && !button('Update Password').disabled, 'Real SDK provider rejection failed to clear expired session/refuse');
  assert((await passwordCalls()).length === 0, 'Provider-rejected session posted a password'); evidence.final = snapshot(); evidence.http = await control();
  assert(evidence.http.calls.filter(call => call.path === '/auth/v1/token' && call.grant === 'refresh_token').length === 1, 'Provider rejection retried unexpectedly');
});
const checkout = { packageTitle: 'Performance Vertex Overhaul', packagePrice: '$84.99', email: 'finish-A@fixture.invalid', discord: 'draft-A', specs: 'Synthetic PC', mainGame: 'Synthetic game', startTimeUTC: '2099-01-05T04:30:00.000Z', displayDate: 'January 5, 2099', displayTime: '10:00 AM', localTimeZone: 'Asia/Kolkata', slotHoldId: 'hold-finish-A', slotHoldToken: 'hold-finish-A-token', slotHoldExpiresAt: '2099-01-05T05:30:00.000Z' };
const fingerprint = checkout => JSON.stringify({ packageTitle: checkout.packageTitle, originalOrderId: '', startTimeUTC: checkout.startTimeUTC, email: checkout.email, referralCode: '', couponCode: '' });
const paymentSession = (token, checkout) => ({ provider: 'dodo', paymentAccessToken: token, fingerprint: fingerprint(checkout), providerPayload: { checkoutUrl: location.origin + '/__ui/hosted/checkout' }, sessionExpiresAt: checkout.slotHoldExpiresAt });
for (const path of ['finalize', 'status', 'start', 'cancel', 'poll']) for (const transition of ['leave', 'same']) for (const status of path === 'finalize' ? ['booked', 'email_partial'] : ['booked']) await run(`payment-${path}-${transition}-${status}`, async evidence => {
  const seed = { checkout_booking_state: checkout, ...(path === 'start' ? {} : { payment_session_state: paymentSession('payment-finish-A', checkout) }) };
  await load('/payment', { seed, holdPath: `/api/payment/${path === 'poll' ? 'status' : path}`, status, finalizeStatus: path === 'poll' ? 'finalizing' : '' });
  if (path === 'finalize' || path === 'poll') { await wait(() => button('Check payment status'), 'A recovery button absent'); await click('Check payment status'); }
  else if (path === 'cancel') { await wait(() => button('Change payment method'), 'A cancellation absent'); await click('Change payment method'); }
  else { const label = path === 'status' ? 'Resume checkout' : 'Pay your way'; await wait(() => button(label) && !button(label).disabled, 'A Dodo option absent'); await click(label); }
  await wait(async () => (await control()).pending.includes('payment-A'), `Actual A ${path} HTTP not held`); evidence.pendingA = snapshot();
  if (transition === 'leave') { route('/terms'); await wait(() => text().includes('Synthetic policy'), 'A payment view not left'); }
  const bCheckout = { ...checkout, email: 'finish-B@fixture.invalid', discord: 'draft-B', slotHoldId: 'hold-finish-B', slotHoldToken: 'hold-finish-B-token' };
  const bSession = paymentSession('payment-finish-B', bCheckout); const bHold = { holdId: 'hold-finish-B', holdToken: 'hold-finish-B-token', expiresAt: bCheckout.slotHoldExpiresAt, startTimeUTC: bCheckout.startTimeUTC, packageTitle: bCheckout.packageTitle, phase: 'payment_pending' };
  sessionStorage.setItem('checkout_booking_state', JSON.stringify(bCheckout)); sessionStorage.setItem('payment_session_state', JSON.stringify(bSession)); sessionStorage.setItem('my_slot_hold', JSON.stringify(bHold)); sessionStorage.setItem('booking_form_draft', JSON.stringify({ discord: 'draft-B' }));
  route('/payment?generation=B', { bookingData: bCheckout }); await wait(() => button('Resume checkout') && storage('payment_session_state')?.paymentAccessToken === 'payment-finish-B', 'B session not restored'); await delay(150); evidence.currentB = snapshot();
  const requestPath = `/api/payment/${path === 'poll' ? 'status' : path}`;
  const responses = () => win().performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === requestPath);
  const completedBefore = responses().length;
  await release('payment-A'); await wait(() => responses().length > completedBefore, 'Actual held A response did not complete'); await delay(800); evidence.final = snapshot(); evidence.http = await control();
  evidence.completedResponse = responses().at(-1).toJSON();
  assert(win().location.pathname === '/payment' && win().location.search === '?generation=B', 'Obsolete A response navigated B');
  assert(storage('payment_session_state')?.paymentAccessToken === 'payment-finish-B', 'Obsolete A erased/replaced B token');
  assert(storage('checkout_booking_state')?.slotHoldId === 'hold-finish-B' && storage('my_slot_hold')?.holdId === 'hold-finish-B', 'Obsolete A response replaced B checkout/hold');
  assert(storage('booking_form_draft')?.discord === 'draft-B' && !storage('booking_confirmation_state'), 'Obsolete A response damaged B draft or stored A receipt');
});
for (const path of ['finalize', 'status', 'start', 'cancel', 'poll']) await run(`payment-current-${path}`, async evidence => {
  await load('/payment', { seed: { checkout_booking_state: checkout, ...(path === 'start' ? {} : { payment_session_state: paymentSession('payment-finish-A', checkout) }) }, finalizeStatus: path === 'poll' ? 'finalizing' : '' });
  const label = path === 'start' ? 'Pay your way' : path === 'status' ? 'Resume checkout' : path === 'cancel' ? 'Change payment method' : 'Check payment status';
  await wait(() => button(label) && !button(label).disabled, 'Current payment action not ready'); await click(label);
  if (path === 'cancel') {
    await wait(() => text().includes('Payment method released.'), 'Current cancellation not completed'); assert(storage('checkout_booking_state')?.slotHoldId === 'hold-finish-A-refreshed' && storage('my_slot_hold')?.holdId === 'hold-finish-A-refreshed', 'Current refreshed hold lost'); assert(win().location.pathname === '/payment', 'Current cancel navigated incorrectly');
  } else {
    await wait(() => win().location.pathname === '/payment-success', 'Current payment success not reached'); assert(storage('booking_confirmation_state')?.bookingId === 'receipt-finish-A' && storage('booking_confirmation_state')?.emailDispatchToken === 'receipt-finish-A-token', 'Current receipt missing'); assert(!storage('checkout_booking_state') && !storage('my_slot_hold'), 'Current success did not finish checkout/hold');
  }
  assert(!storage('payment_session_state'), 'Current completed session remains'); evidence.final = snapshot(); evidence.http = await control();
});
await run('timing-ready', async evidence => { await load('/', {}); await wait(() => doc().querySelector('a.book-optimization-button'), 'Actual CTA absent'); await delay(500); evidence.ready = true; });
await saveIndex(true);
window.__uiFinishResults = results; window.__uiFinishComplete = true;
