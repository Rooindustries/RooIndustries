const testHost = window.location.hostname;
const results = [];
const output = document.getElementById('results');
const frame = document.getElementById('app');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const wait = async (predicate, message, timeout = 45000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await predicate(); if (value) return value; await delay(100); }
  throw new Error(message);
};
const control = async value => (await fetch('/__ui/control', value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {})).json();
const cookie = (name, value) => { document.cookie = `${name}=base64-${btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}; path=/; SameSite=Lax`; };
const clear = () => {
  for (const name of document.cookie.split(';').map(value => value.trim().split('=')[0])) if (name.startsWith('sb-100-')) document.cookie = `${name}=; path=/; Max-Age=0`;
  for (const key of ['referral_reset_token', 'referral_recovery_session', 'checkout_booking_state', 'booking_draft', 'refPendingDiscordChoice']) sessionStorage.removeItem(key);
};
const load = async url => {
  frame.src = 'about:blank';
  await delay(20);
  frame.src = url;
  await wait(() => { try { return frame.contentWindow.location.pathname === new URL(url, location.origin).pathname && (frame.contentDocument?.querySelector('main') || (url.endsWith('.html') && frame.contentDocument?.body)); } catch { return false; } }, `Load ${url} failed.`);
  return frame.contentDocument;
};
const recoveryReady = async () => wait(() => frame.contentDocument.querySelector('#ref-reset-new-password') || [...frame.contentDocument.querySelectorAll('h1')].find(node => node.textContent === 'Invalid Link'), 'Recovery initialization timed out.');
const input = (selector, value) => {
  const node = frame.contentDocument.querySelector(selector);
  assert(node, `Missing ${selector}`);
  Object.getOwnPropertyDescriptor(frame.contentWindow.HTMLInputElement.prototype, 'value').set.call(node, value);
  node.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true }));
};
const submit = async () => {
  input('#ref-reset-new-password', 'Synthetic-password-1!'); input('#ref-reset-confirm-password', 'Synthetic-password-1!');
  frame.contentDocument.querySelector('form').dispatchEvent(new frame.contentWindow.Event('submit', { bubbles: true, cancelable: true }));
  await wait(() => /Password updated/.test(frame.contentDocument.body.textContent), 'Password submission did not finish.');
};
const run = async (name, action) => {
  try { const evidence = await action(); results.push({ name, ok: true, ...evidence }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); }
  output.textContent = JSON.stringify(results, null, 2);
  await fetch('/__ui/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ complete: false, results }) });
};
const link = (type, session) => type === 'code' ? '/referrals/reset?code=synthetic-code' : type === 'token_hash' ? '/referrals/reset?token_hash=synthetic-hash&type=recovery' : `/referrals/reset#type=recovery&access_token=${session.access_token}&refresh_token=${session.refresh_token}`;
const redeem = async (type, mode = 'valid', staleLegacy = true) => {
  clear(); const value = await control({ scenario: type, mode: type === 'code' && mode === 'valid' ? 'pkce-recovery' : mode });
  if (staleLegacy) sessionStorage.setItem('referral_reset_token', 'e'.repeat(64));
  cookie('sb-100-auth-token-code-verifier', 'synthetic-verifier/recovery');
  await load(link(type, value.session)); await recoveryReady();
};
const requested = new URLSearchParams(location.search).get('scenario');
for (const type of ['code', 'token_hash', 'access_token']) {
  const name = `stale-legacy-fresh-${type}`;
  if (requested && requested !== name && requested !== 'recovery') continue;
  await run(name, async () => {
    await redeem(type); assert(frame.contentDocument.querySelector('#ref-reset-new-password'), 'Fresh link did not open reset form.');
    assert(sessionStorage.getItem('referral_reset_token') === null, 'Stale legacy token survived new link.');
    assert(!frame.contentWindow.location.search && !frame.contentWindow.location.hash, 'Recovery credentials not scrubbed.');
    await submit(); const calls = (await control()).calls;
    assert(calls.filter(value => value.path === '/api/ref/recoverPassword').length === 1, 'Wrong or duplicate password endpoint.');
    assert(!calls.some(value => value.path === '/api/ref/reset'), 'Legacy endpoint used for Supabase link.');
    assert(calls.filter(value => value.path === '/auth/v1/token' || value.path === '/auth/v1/verify').length === (type === 'access_token' ? 0 : 1), 'One-use credential exchanged more than once.');
    return { calls, standIn: 'local synthetic Auth/password HTTP responses; actual Supabase SSR/Auth clients and RefReset in real browser' };
  });
}
if (!requested || requested === 'recovery' || requested === 'reload' || requested === 'retry') {
  await run('pending-retry-refuses-switched-recovery-user', async () => {
    await redeem('token_hash'); await control({ scenario: 'pending-switch', mode: 'pending-switch' });
    input('#ref-reset-new-password', 'Synthetic-password-1!'); input('#ref-reset-confirm-password', 'Synthetic-password-1!');
    frame.contentDocument.querySelector('form').dispatchEvent(new frame.contentWindow.Event('submit', { bubbles: true, cancelable: true }));
    await wait(() => frame.contentDocument.body.textContent.includes('This recovery session changed or expired.'), 'Changed user was not refused before retry.', 12000);
    const calls = (await control()).calls;
    assert(calls.filter(value => value.path === '/api/ref/recoverPassword').length === 1, 'Retry sent a second password POST using changed identity.');
    return { ordering: 'POST A -> 202 plus cookie B -> retry refuses', calls, limitation: 'Atomic server binding still needed after client recheck.' };
  });
}
if (!requested || requested === 'recovery' || requested === 'reload') {
  await run('recovery-scrub-reload-submit', async () => {
    await redeem('token_hash', 'valid', false); assert(frame.contentDocument.querySelector('#ref-reset-new-password'), 'Recovery form absent.');
    const marker = JSON.parse(sessionStorage.getItem('referral_recovery_session') || 'null');
    await load('/referrals/reset'); await recoveryReady(); assert(frame.contentDocument.querySelector('#ref-reset-new-password'), 'Reload rejected valid recovery.');
    await submit(); const calls = (await control()).calls;
    assert(calls.filter(value => value.path === '/auth/v1/verify').length === 1, 'Reload redeemed link again.');
    assert(calls.filter(value => value.path === '/api/ref/recoverPassword').length === 1, 'Reload submission used wrong endpoint.');
    assert(sessionStorage.getItem('referral_recovery_session') === null, 'Completed recovery marker remains.'); return { marker, calls };
  });
  await run('open-form-refuses-switched-recovery-user', async () => {
    await redeem('token_hash'); const value = await control({ scenario: 'switched-open-form', mode: 'switched' }); cookie('sb-100-auth-token', value.session);
    input('#ref-reset-new-password', 'Synthetic-password-1!'); input('#ref-reset-confirm-password', 'Synthetic-password-1!');
    frame.contentDocument.querySelector('form').dispatchEvent(new frame.contentWindow.Event('submit', { bubbles: true, cancelable: true }));
    await wait(() => frame.contentDocument.querySelector('[role=alert]'), 'Changed recovery user was not refused.');
    assert(!(await control()).calls.some(value => value.path === '/api/ref/recoverPassword'), 'Wrong recovery user received password submission.');
    return { refusedBeforePasswordPost: true, limitation: 'atomic cookie replacement after client recheck requires backend expected identity comparison' };
  });
  await run('legacy-resume-without-new-link', async () => {
    clear(); await control({ scenario: 'legacy-resume' }); sessionStorage.setItem('referral_reset_token', 'a'.repeat(64));
    await load('/referrals/reset'); await recoveryReady(); await submit(); const calls = (await control()).calls;
    assert(calls.length === 1 && calls[0].path === '/api/ref/reset', 'Legacy resume lost.'); return { calls };
  });
  await run('failed-fresh-link-does-not-fallback', async () => {
    await redeem('token_hash', 'invalid'); assert(frame.contentDocument.querySelector('h1')?.textContent === 'Invalid Link', 'Failed new link used stale legacy token.');
    assert(!sessionStorage.getItem('referral_reset_token'), 'Failed fresh link left stale legacy token.'); return { calls: (await control()).calls };
  });
  for (const mode of ['ordinary', 'stale', 'future', 'expired', 'mismatched', 'old-otp']) {
    await run(`resume-refuses-${mode}`, async () => {
      await redeem('token_hash'); const marker = JSON.parse(sessionStorage.getItem('referral_recovery_session') || 'null'); assert(marker, 'Valid redemption marker absent.');
      const value = await control({ scenario: `resume-${mode}`, mode }); cookie('sb-100-auth-token', value.session);
      await load('/referrals/reset'); await recoveryReady(); assert(frame.contentDocument.querySelector('h1')?.textContent === 'Invalid Link', `Resumed ${mode} session.`);
      assert(!(await control()).calls.some(value => value.path.startsWith('/api/ref/')), 'Rejected session submitted password.'); return { refused: true };
    });
  }
  await run('resume-refuses-changed-session', async () => {
    await redeem('token_hash'); const marker = JSON.parse(sessionStorage.getItem('referral_recovery_session')); marker.sessionId = 'other-session'; sessionStorage.setItem('referral_recovery_session', JSON.stringify(marker));
    await load('/referrals/reset'); await recoveryReady(); assert(frame.contentDocument.querySelector('h1')?.textContent === 'Invalid Link', 'Changed session resumed.'); return { refused: true };
  });
  await run('resume-refuses-no-marker', async () => {
    await redeem('token_hash'); sessionStorage.removeItem('referral_recovery_session'); await load('/referrals/reset'); await recoveryReady();
    assert(frame.contentDocument.querySelector('h1')?.textContent === 'Invalid Link', 'Unmarked session resumed.'); return { refused: true };
  });
}
if (!requested || requested === 'extra' || requested === 'registration') {
  await run('registration-latest-code-wins', async () => {
    clear(); await control({ scenario: 'registration-order' }); await load('/referrals/register'); await wait(() => frame.contentDocument.querySelector('#ref-register-slug')?._valueTracker, 'Registration hydration absent.');
    input('#ref-register-slug', 'oldslug');
    await wait(async () => (await control()).calls.some(value => value.code === 'oldslug'), 'Old request was not sent.');
    input('#ref-register-slug', 'newslug'); await wait(() => frame.contentDocument.body.textContent.includes('Referral code is available.'), 'New available code was not shown.');
    await fetch('/__ui/release-old'); await delay(1100); assert(frame.contentDocument.body.textContent.includes('Referral code is available.'), 'Old taken result replaced current available code.');
    assert(!frame.contentDocument.body.textContent.includes('This referral code is already taken.'), 'Wrong taken status remains.'); return { ordering: 'old request -> new available result -> old taken result', calls: (await control()).calls };
  });
  await run('oauth-choice-dialog-focus-contained', async () => {
    clear(); await control({ scenario: 'dialog' }); await load('/referrals/login?oauth=unlinked&provider=discord');
    const doc = frame.contentDocument; const dialog = await wait(() => doc.querySelector('[role=dialog]'), 'OAuth choice dialog absent.');
    const buttons = [...dialog.querySelectorAll('button')]; assert(buttons.length === 2, 'OAuth dialog controls changed.');
    buttons[1].focus(); frame.contentWindow.dispatchEvent(new frame.contentWindow.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert(doc.activeElement === buttons[0], 'Tab at last control did not wrap to first.');
    buttons[0].focus(); frame.contentWindow.dispatchEvent(new frame.contentWindow.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert(doc.activeElement === buttons[1], 'Shift+Tab at first control did not wrap to last.');
    return { controls: buttons.map(node => node.textContent.trim()), bothBoundariesContained: true, standIn: 'actual DOM KeyboardEvent exercises boundary listener; browser default key behavior separately inspected in T3' };
  });
}
if (!requested || requested === 'dompurify') await run('dompurify-detached-img-browser', async () => {
  const root = document.createElement('div'); root.id = 'root'; root.innerHTML = '<section id="wrap"><img onerror="bad()"></section>'; document.body.append(root);
  const img = root.querySelector('img'); let executions = 0; window.bad = () => executions++;
  DOMPurify.addHook('afterSanitizeElements', node => { if (node.id === 'wrap') node.remove(); });
  DOMPurify.sanitize(root, { IN_PLACE: true }); DOMPurify.removeAllHooks();
  assert(!img.hasAttribute('onerror'), 'Detached handler retained.'); img.dispatchEvent(new Event('error')); await delay(20);
  assert(executions === 0, 'Detached marker handler executed.'); assert(!img.isConnected, 'Wrapper hook did not detach image.'); root.remove(); delete window.bad;
  return { version: DOMPurify.version, retainedHandler: false, executions, browser: navigator.userAgent, standIn: 'none; actual maintained DOMPurify in actual browser DOM' };
});
if (!requested || requested === 'bios') await run('bios-guide-hardware-specific-recovery', async () => {
  await load('/BIOSGuide/index.html'); const doc = frame.contentDocument;
  assert(!doc.body.textContent.includes('Move the jumper from pins 1-2 to pins 2-3'), 'Universal three-pin reset instruction remains.');
  assert(!doc.body.textContent.includes('It will automatically recover.'), 'Automatic recovery guarantee remains.');
  assert(!doc.body.textContent.includes('XMP/EXPO is NOT Risky Overclocking'), 'Overclocking risk denial remains.');
  assert(!doc.body.textContent.includes('"Auto" does nothing.'), 'Contradictory Auto setting guarantee remains.');
  assert(!doc.body.textContent.includes("You'll boot with default settings"), 'Guaranteed recovery outcome remains.');
  assert(!doc.body.textContent.includes('zero risk'), 'Repeated PBO safety guarantee remains.');
  assert(!doc.body.textContent.includes('up to 95°C safely'), 'Universal Ryzen temperature limit remains.');
  assert(doc.querySelector('a[href="https://www.asus.com/us/support/faq/1040820/"]'), 'Manufacturer reset reference absent.');
  assert(doc.querySelector('a[href="https://www.amd.com/en/legal/claims/gaming-details.html"]'), 'AMD risk/warranty reference absent.');
  assert(/data loss/.test(doc.body.textContent) && /warranty/.test(doc.body.textContent), 'Material risk disclosure absent.');
  return { twoPinManualReference: true, recoveryNotGuaranteed: true, riskAndWarrantyDisclosed: true, remoteReferencesFollowed: false };
});
if (!requested || requested === 'routes') {
  await run('isolated-proxy-refuses-external-redirect', async () => {
    const response = await fetch('/discord', { redirect: 'manual' });
    assert(response.status === 503 && !response.headers.has('location'), 'Local proxy returned an external navigation target.');
    return { status: response.status, externalRedirectFollowed: false };
  });
  await run('local-home-telemetry-isolation', async () => {
    clear(); await load('/'); await wait(() => frame.contentDocument.body.textContent.includes('More FPS. Less Input Lag.'), 'Current conversion homepage absent.'); await delay(6500);
    const doc = frame.contentDocument;
    assert(!doc.querySelector('#intercom-embed-script,script[src*="/_vercel/"],script[src*="vercel-scripts.com"],#seorce-runtime-script'), 'Production telemetry initialized locally.');
    assert(!doc.querySelector('link[rel="preconnect"][href*="supabase.co"]'), 'Production preconnect ignores fixture asset origin.');
    return { scripts: [...doc.scripts].map(value => value.src).filter(Boolean), remoteResources: frame.contentWindow.performance.getEntriesByType('resource').filter(value => !value.name.startsWith(location.origin)).map(value => value.name) };
  });
  await run('static-entry-local-isolation', async () => {
    await load('/index.html'); const doc = frame.contentDocument; await delay(300);
    assert(!doc.querySelector('script[src*="googletagmanager"],link[rel="preconnect"][href*="sanity.io"]'), 'Static page initialized remote integrations.');
    assert(!doc.documentElement.innerHTML.includes('%PUBLIC_URL%'), 'Literal CRA public asset placeholder remains.');
    const icon = doc.querySelector('link[rel="icon"]'); assert((await fetch(icon.getAttribute('href'))).ok, 'Static entry icon not served.');
    return { remoteIntegrations: false, icon: icon.getAttribute('href') };
  });
  await run('tourney-mobile-layout', async () => {
    const evidence = [];
    for (const width of [320, 390]) {
      frame.style.width = `${width}px`; await load('/tourney'); const doc = frame.contentDocument;
      const boxes = [...doc.querySelectorAll('.tourney-podium-finish,.tourney-nav .nav-cta,[role=switch]')].map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; });
      assert(boxes.length === 5 && boxes.every(box => box.width > 0 && box.left >= 0 && box.right <= width + 1), `Mobile controls/podium overflow at ${width}px.`);
      assert(doc.documentElement.scrollWidth <= width + 1, `Document overflow at ${width}px.`);
      evidence.push({ width, documentWidth: doc.documentElement.scrollWidth, boxes });
    }
    frame.style.width = '100%'; return { evidence };
  });
  await run('payment-storage-not-query', async () => {
    clear(); sessionStorage.setItem('checkout_booking_state', JSON.stringify({ packageTitle: 'Performance Vertex Overhaul', packagePrice: '$84.99', startTimeUTC: '2099-01-05T04:30:00.000Z', displayDate: 'Monday, January 5, 2099', displayTime: '10:00 AM', localTimeZone: 'Asia/Kolkata', slotHoldId: 'hold_smoke_test', slotHoldToken: 'hold_token_smoke_test', slotHoldExpiresAt: '2099-01-05T05:30:00.000Z' }));
    await load('/payment'); await wait(() => frame.contentDocument.body.innerText.includes('Performance Vertex Overhaul'), 'Synthetic stored checkout failed to hydrate.');
    assert(/Complete Payment/i.test(frame.contentDocument.body.innerText), 'Stored checkout heading absent.');
    await wait(() => frame.contentDocument.body.innerText.includes('Price confirmation is unavailable. Payment is disabled.'), 'Unavailable price dependency did not disable payment.');
    assert(!frame.contentWindow.location.search, 'Checkout put fixture data in URL.');
    return { package: 'Performance Vertex Overhaul', noPaymentAttempted: true, unavailableQuoteRefusesPayment: true, standIn: 'Synthetic checkout state; provider APIs refused; verifies render and quote failure only' };
  });
  await run('completed-tourney-and-retired-routes', async () => {
    await load('/tourney'); const doc = frame.contentDocument;
    assert(doc.querySelector('main[data-tourney-state="results"]'), 'Wrong tourney state.'); assert(doc.querySelector('ol[aria-label="Tournament podium"]')?.children.length === 3, 'Podium absent.');
    assert(doc.body.textContent.includes('GetSkii’d') && doc.body.textContent.includes('Rents Due'), 'Published results absent.');
    const toggle = await wait(() => doc.querySelector('[role="switch"]'), 'Theme switch absent.'); const previous = toggle.getAttribute('aria-checked'); toggle.click(); await wait(() => toggle.getAttribute('aria-checked') !== previous, 'Theme did not change.');
    const statuses = {};
    for (const route of ['login', 'register', 'forgot', 'reset', 'manage']) { const response = await fetch(`/tourney/${route}`); statuses[route] = response.status; assert(response.status === 404, `Retired ${route} not 404.`); }
    for (const route of ['bracket', 'roster']) { const response = await fetch(`/tourney/${route}`); assert(new URL(response.url).pathname === '/tourney' && response.ok, `Legacy ${route} did not redirect.`); }
    return { statuses, themeToggled: true };
  });
}
try {
  const { isProductionBrowser } = await import('/__ui/productionBrowser.js');
  await run('production-host-runtime-policy', async () => {
    const refused = [testHost, 'localhost', '127.0.0.1', 'rooindustries.vercel.app', 'preview.rooindustries.com', 'rooindustries.com.evil.invalid'];
    for (const hostname of refused) assert(!isProductionBrowser(hostname, { NODE_ENV: 'production', VERCEL_ENV: 'production' }), `Allowed ${hostname}`);
    for (const hostname of ['rooindustries.com', 'www.rooindustries.com']) { assert(isProductionBrowser(hostname, { NODE_ENV: 'production', VERCEL_ENV: 'production' }), `Refused ${hostname}`); assert(!isProductionBrowser(hostname, { NODE_ENV: 'production', VERCEL_ENV: 'preview' }), 'Preview runtime admitted.'); }
    return { refused, allowed: ['rooindustries.com', 'www.rooindustries.com'] };
  });
} catch (error) { results.push({ name: 'production-host-runtime-policy', ok: false, error: error.message }); }
const evidence = { complete: true, results, passed: results.filter(value => value.ok).length, failed: results.filter(value => !value.ok).length, standIns: 'Synthetic Auth/password/content/availability HTTP fixtures. No database/transaction behavior is replaced in a claimed frontend invariant. CSP blocks remote browser loads before every navigation; Node guard blocks server external requests.' };
window.__uiSweep = evidence; output.textContent = JSON.stringify(evidence, null, 2);
await fetch('/__ui/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evidence) });
