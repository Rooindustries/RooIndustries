const output = document.getElementById('results');
const frame = document.getElementById('app');
const params = new URLSearchParams(location.search);
const requested = params.get('scenario') || 'all';
const phase = params.get('phase') || 'after';
const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const wait = async (fn, message, ms = 8000) => { const start = Date.now(); while (Date.now() - start < ms) { const value = await fn(); if (value) return value; await delay(100); } throw new Error(message); };
const control = async value => (await fetch('/__ui/repairs-control', value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {})).json();
const doc = () => frame.contentDocument;
const win = () => frame.contentWindow;
const text = () => doc()?.body?.innerText || '';
const input = (selector, value) => { const node = doc().querySelector(selector); assert(node, `Missing ${selector}`); const proto = node.tagName === 'TEXTAREA' ? win().HTMLTextAreaElement.prototype : win().HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value); node.dispatchEvent(new (win().Event)('input', { bubbles: true })); };
const button = label => [...doc().querySelectorAll('button')].find(node => node.textContent.trim().startsWith(label) || node.getAttribute('aria-label') === label);
const click = async label => { const node = await wait(() => button(label), `Missing button ${label}`); node.click(); await delay(100); };
const submit = () => doc().querySelector('form').dispatchEvent(new (win().Event)('submit', { bubbles: true, cancelable: true }));
const call = async p => wait(async () => (await control()).calls.find(item => item.path === p), `Missing call ${p}`);
const load = async (url, cfg = {}) => {
  await control({ scenario: requested, ...cfg });
  sessionStorage.clear(); localStorage.clear();
  frame.src = 'about:blank'; await wait(() => doc()?.URL === 'about:blank', 'Frame did not clear'); frame.src = url;
  await wait(() => { try { return (win().location.pathname === new URL(url, location.origin).pathname || (cfg.mode === 'expired' && win().location.pathname === '/referrals/login')) && (doc().querySelector('main') || (url.endsWith('.html') && doc().body)); } catch { return false; } }, `Load ${url}`);
  await delay(700);
};
const release = key => fetch(`/__ui/repairs-release?key=${key}`);
const save = complete => fetch('/__ui/repairs-evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase, scenario: requested, complete, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }) });
const run = async (name, action) => {
  if (requested !== 'all' && !(requested === 'baseline-final' && ['storage-login-setItem','warranty-parity','booking-hold-write','booking-banner-release','booking-captured-remove'].includes(name)) && !(requested === 'account-baseline' && /^storage-(login|register|verify)-/.test(name)) && !(requested === 'recheck' && ['hero-resize','warranty-parity','storage-home-property','storage-home-getItem','storage-home-setItem','storage-home-removeItem'].includes(name)) && !(requested === 'remaining' && ['editor-draft-order','contact-config','games-sparse','games-populated','warranty-parity','reviews-rating','reviews-pause','booking-captured-remove','recovery-hash-only'].includes(name)) && requested !== name && !name.startsWith(`${requested}-`)) return;
  try { const evidence = await action(); results.push({ name, ok: true, ...evidence, fixtureHydrationWarnings: win()?.__uiHydrationWarnings?.length || 0 }); }
  catch (error) { results.push({ name, ok: false, error: error.message, url: win()?.location.href, rendered: text().slice(-1800), errors: win()?.__uiErrors || [], calls: (await control()).calls }); }
  output.textContent = JSON.stringify(results, null, 2); await save(false);
};
const checkout = { packageTitle: 'Performance Vertex Overhaul', packagePrice: '$84.99', email: 'ui@fixture.invalid', discord: 'synthetic', specs: 'Synthetic PC', mainGame: 'Synthetic game', startTimeUTC: '2099-01-05T04:30:00.000Z', displayDate: 'January 5, 2099', displayTime: '10:00 AM', localTimeZone: 'Asia/Kolkata', slotHoldId: 'hold-ui', slotHoldToken: 'hold-token-ui', slotHoldExpiresAt: new Date(Date.now() + 3600000).toISOString() };
const seedCheckout = { checkout_booking_state: checkout };
for (const route of ['xoc', 'link', 'slug']) await run(`upgrade-${route}`, async () => {
  await load(route === 'xoc' ? '/upgrade-xoc' : '/upgrade/slugA'); await wait(() => doc().querySelector('input[type=email]')?._valueTracker, 'Upgrade hydration');
  input('input[type=email]', 'emailA@fixture.invalid'); input('input[placeholder^="e.g."]', 'orderA'); await click('Check eligibility'); await call('/api/ref/getUpgradeInfo');
  input('input[type=email]', 'emailB@fixture.invalid'); input('input[placeholder^="e.g."]', 'orderB');
  if (route === 'slug') { win().history.pushState({ ...win().history.state, __rooLegacy: true }, '', '/upgrade/slugB'); win().dispatchEvent(new (win().PopStateEvent)('popstate', { state: win().history.state })); await delay(300); input('input[type=email]', 'emailB@fixture.invalid'); input('input[placeholder^="e.g."]', 'orderB'); }
  await release('upgrade'); await delay(500);
  const stale = text().includes('Upgrade Summary'); assert(!stale, 'Late response A restored stale eligibility after input/slug B');
  await click('Check eligibility'); await wait(async () => (await control()).calls.filter(c => c.path === '/api/ref/getUpgradeInfo').length === 2, 'Current B request absent'); await release('upgrade'); await wait(() => text().includes('Upgrade Summary'), 'Current B eligibility not displayed');
  const proceed = [...doc().querySelectorAll('button')].find(node => /Proceed/.test(node.textContent)); assert(proceed, 'Proceed button absent'); proceed.click();
  await wait(() => win().location.pathname === '/payment', 'Current eligibility cannot proceed'); const stored = JSON.parse(sessionStorage.getItem('checkout_booking_state'));
  assert(stored.originalOrderId === 'orderB' && stored.email === 'emailB@fixture.invalid' && stored.upgradeIntentToken === 'intent-orderB', 'Checkout did not bind B snapshot'); return { snapshot: stored, calls: (await control()).calls };
});
await run('editor-draft-order', async () => {
  await load('/admin/referrals'); await wait(() => doc().querySelector('#ref-admin-key')?._valueTracker, 'Editor hydration'); input('#ref-admin-key', 'synthetic-key'); submit(); await click('Synthetic creator');
  await wait(() => doc().querySelector('textarea'), 'Draft absent'); input('textarea', 'reasonA'); await click('Save creator settings'); await call('/api/admin/referral-creators');
  await wait(async () => (await control()).calls.some(c => c.method === 'PATCH'), 'Save A not pending'); input('input[type=number]', '25'); input('input[type=number]:nth-of-type(1)', '25');
  const fields = [...doc().querySelectorAll('input[type=number]')]; input('input[type=number]', '25');
  Object.getOwnPropertyDescriptor(win().HTMLInputElement.prototype, 'value').set.call(fields[2], '10'); fields[2].dispatchEvent(new (win().Event)('input', { bubbles: true })); input('textarea', 'reasonB');
  await delay(100); await release('editor'); await delay(500);
  const actual = { total: fields[0].value, discount: fields[1].value, commission: fields[2].value, reason: doc().querySelector('textarea').value };
  assert(actual.total === '25' && actual.commission === '10' && actual.discount === '15' && actual.reason === 'reasonB', `Later draft B discarded: ${JSON.stringify(actual)}`); return { actual, calls: (await control()).calls };
});
await run('contact-config', async () => {
  await load('/contact', { mode: 'delayed' }); await call('/api/content/contact'); const blockedBeforeConfig = !button('Send Message') || button('Send Message').disabled;
  await release('contact'); await wait(() => text().includes('Synthetic contact'), 'Delayed CMS configuration absent');
  input('input[name=name]', 'Synthetic name'); input('input[name=email]', 'ui@fixture.invalid'); input('textarea[name=message]', 'Synthetic message'); submit(); await call('/__ui/formspree');
  const calls = (await control()).calls.filter(c => c.path === '/__ui/formspree'); assert(calls.length === 1 && calls[0].form === 'formB' && blockedBeforeConfig, `Real Formspree SDK ignored delayed configured formB: ${JSON.stringify({calls,blockedBeforeConfig})}`);
  await wait(() => text().includes('Your message has been sent'), 'SDK success response not rendered'); return { calls, externalSends: 0, standIn: 'Actual @formspree/react3 SDK; browser fetch redirected before network to local HTTP' };
});
await run('hero-resize', async () => {
  frame.style.width = '320px'; await load('/'); await wait(() => doc().querySelector('.ri-hero-cta-note'), 'Hero note absent'); await delay(400);
  const narrow = [...doc().querySelectorAll('.ri-hero-cta-note')].map(n => ({ paragraphs: n.querySelectorAll('p:not([aria-hidden=true])').length, width: n.clientWidth, scrollWidth: n.scrollWidth }));
  assert(narrow.some(n => n.paragraphs === 2), 'Narrow320 did not produce split'); frame.style.width = '1440px'; doc().querySelector('.ri-hero-cta-note').getBoundingClientRect(); win().dispatchEvent(new (win().Event)('resize')); await delay(500); await wait(() => [...doc().querySelectorAll('.ri-hero-cta-note')].every(n => n.querySelectorAll('p:not([aria-hidden=true])').length === 1), 'Wide1440 remains split after layout', 2500);
  const wide = [...doc().querySelectorAll('.ri-hero-cta-note')].map(n => ({ paragraphs: n.querySelectorAll('p:not([aria-hidden=true])').length, width: n.clientWidth, scrollWidth: n.scrollWidth }));
  assert(wide.every(n => n.paragraphs === 1), `Wide1440 remains split: ${JSON.stringify(wide)}`); assert(narrow.every(n => n.scrollWidth <= n.width + 1) && wide.every(n => n.scrollWidth <= n.width + 1), `Note overflows narrow=${JSON.stringify(narrow)} wide=${JSON.stringify(wide)}`); frame.style.width = '100%'; return { narrow, wide };
});
for (const mode of ['sparse', 'populated']) await run(`games-${mode}`, async () => {
  await load('/#faq', { mode }); await wait(() => doc().querySelector('#supported-games'), 'Games container absent'); doc().querySelector('#supported-games').scrollIntoView(); await wait(() => button('View All Games'), 'Games missing'); await click('View All Games'); await delay(800);
  const more = doc().querySelector('#supported-games-more'); assert(more && more.getAttribute('aria-hidden') === 'false' && more.getBoundingClientRect().height > 30, 'View All cannot reveal extra game'); assert(more.querySelector('.game-card'), 'Extra card absent'); return { mode, height: more.getBoundingClientRect().height, cards: doc().querySelectorAll('#supported-games .game-card').length };
});
await run('policy-links', async () => {
  const pages = [];
  for (const route of ['/terms', '/privacy']) {
    await load(route); await wait(() => [...doc().querySelectorAll('a')].some(n => n.textContent.includes('fixture-link')), 'Policy fixture missing');
    const actual = [...doc().querySelectorAll('a')].filter(n => n.textContent.includes('fixture-link')).map(n => n.getAttribute('href'));
    const expected = (await control()).hrefs.map(h => h === '/contact' ? 'mailto:serviroo@rooindustries.com' : h); assert(JSON.stringify(actual) === JSON.stringify(expected), `Policy link rewrite: ${JSON.stringify(actual)}`); pages.push({ route, actual });
  } return { pages };
});
await run('warranty-parity', async () => {
  await load('/#faq'); await wait(() => button('Do you offer a money-back guarantee? What is the warranty?') || [...doc().querySelectorAll('button')].some(n => /money-back guarantee/.test(n.textContent)), 'FAQ absent');
  [...doc().querySelectorAll('button')].find(n => /money-back guarantee/.test(n.textContent)).click(); await delay(300);
  assert(text().includes('Overhaul includes a 90-day warranty'), 'FAQ still promises30-day warranty'); assert(text().includes('90-day warranty included'), 'Card90-day promise absent'); assert(text().includes('lifetime warranty'), 'Max lifetime warranty changed'); return { faq90days: true, card90days: true, maxLifetime: true };
});
await run('reviews-rating', async () => {
  await load('/#faq'); await wait(() => doc().querySelector('.ri-reviews-auto-track article'), 'Reviews absent');
  const ratings = [...doc().querySelectorAll('.ri-reviews-auto-track > div:first-child [aria-label$="out of 5 stars"]')].map(n => ({ label: n.getAttribute('aria-label'), filled: (n.textContent.match(/★/g) || []).length, text: n.textContent }));
  assert(ratings.length === 4 && ratings.every((n, i) => n.filled === [1, 3, 5, 5][i]), `Filled stars mismatch: ${JSON.stringify(ratings)}`); return { ratings };
});
await run('reviews-pause', async () => {
  await load('/?perfdebug=1#faq'); await wait(() => doc().querySelector('.ri-reviews-auto-track'), 'Reviews absent');
  win().__uiReducedMotion(false); await delay(150); const viewport = doc().querySelector('.ri-reviews-auto-track').parentElement; viewport.scrollLeft = 100; assert(viewport.scrollWidth > viewport.clientWidth, 'Carousel lacks overflow');
  const pauseLabel = [...doc().querySelectorAll('label')].find(n => n.textContent.includes('Pause reviews autoplay')); assert(pauseLabel, 'Pause control absent'); pauseLabel.querySelector('input').click(); await delay(150); const pausedAt = viewport.scrollLeft; await delay(650); assert(viewport.scrollLeft === pausedAt, `Pause ignored ${pausedAt}->${viewport.scrollLeft}`);
  pauseLabel.querySelector('input').click(); await delay(150); const resumedAt = viewport.scrollLeft; await delay(650); assert(viewport.scrollLeft > resumedAt, 'Resume did not move');
  win().__uiReducedMotion(true); await delay(150); const reducedAt = viewport.scrollLeft; await delay(650); assert(viewport.scrollLeft === reducedAt, 'Live reduced motion ignored'); win().__uiReducedMotion(false); await delay(650); assert(viewport.scrollLeft > reducedAt, 'Reduced motion removal did not resume'); return { pausedAt, resumedAt, reducedAt, reducedMotionStandIn: 'Native MediaQueryList with controlled matches and native change event; OS preference itself not changed' };
});
await run('navbar-focus', async () => {
  frame.style.width = '390px'; await load('/'); await wait(() => doc().querySelector('#mobile-site-menu'), 'Mobile menu missing'); const menu = doc().querySelector('#mobile-site-menu'); assert(menu.inert, 'Closed main menu is not inert');
  doc().querySelector('[aria-controls="mobile-site-menu"]').click(); await delay(350); assert(!menu.inert, 'Open main menu remains inert');
  assert(doc().querySelector('#mobile-proof-menu').inert && doc().querySelector('#mobile-referrals-menu').inert, 'Closed submenus are focusable');
  doc().querySelector('[aria-controls="mobile-proof-menu"]').click(); await delay(350); assert(!doc().querySelector('#mobile-proof-menu').inert, 'Open Proof remains inert'); return { closedMainInert: true, closedSubmenusInert: true, openProofUsable: true, nativeTabProof: 'separate T3 key presses required' };
});
for (const denial of ['property', 'getItem', 'setItem', 'removeItem']) await run(`storage-home-${denial}`, async () => {
  await load('/?perfdebug=1', { denial }); await wait(() => text().includes('More FPS. Less Input Lag.'), 'Storage denial broke home'); await delay(300); assert(!win().__uiErrors.length, `Storage errors: ${win().__uiErrors}`);
  const label = [...doc().querySelectorAll('label')].find(n => n.textContent.includes('Pause reviews autoplay')); assert(label, 'Debug overlay absent on query'); label.querySelector('input').click(); await delay(100); assert(!win().__uiErrors.length, `Toggle storage failure escapes: ${win().__uiErrors}`); if (denial === 'removeItem') { await click('Hide'); await wait(() => !text().includes('Pause reviews autoplay'), 'Hide/remove denied did not preserve in-memory action'); assert(!win().__uiErrors.length, 'Remove storage failure escaped'); } return { denial, homeUsable: true };
});
for (const denial of ['property', 'getItem', 'setItem']) await run(`storage-login-${denial}`, async () => {
  await load('/referrals/login', { denial }); await wait(() => doc().querySelector('#ref-login-identifier')?._valueTracker, 'Login form/hydration absent'); assert(!win().__uiErrors.length, `Initial storage failure: ${win().__uiErrors}`);
  input('#ref-login-identifier', 'synthetic'); input('#ref-login-password', 'Synthetic-password1!'); submit(); await call('/api/ref/login'); await wait(() => win().location.pathname === '/referrals/dashboard', 'Successful login lost to optional storage'); return { denial, calls: (await control()).calls };
});
for (const denial of ['property', 'getItem', 'removeItem']) await run(`storage-register-${denial}`, async () => {
  await load('/referrals/register', { denial, seed: denial === 'removeItem' ? { referral_signup_draft: '{invalid' } : {} }); await wait(() => doc().querySelector('#ref-register-slug')?._valueTracker, 'Register hydration absent'); assert(!win().__uiErrors.length, `Draft storage failure: ${win().__uiErrors}`);
  input('#ref-register-discord', 'synthetic'); input('#ref-register-email', 'ui@fixture.invalid'); input('#ref-register-paypal', 'ui@fixture.invalid'); input('#ref-register-slug', 'synthetic'); input('#ref-register-password', 'Synthetic-password1!'); input('#ref-register-confirm', 'Synthetic-password1!'); await delay(700); submit(); await call('/api/ref/register'); await wait(() => text().includes('Check your email'), 'Successful registration lost to storage'); return { denial, calls: (await control()).calls };
});
for (const denial of ['property', 'setItem', 'removeItem']) await run(`storage-verify-${denial}`, async () => {
  await load('/referrals/verify#token=' + 'a'.repeat(43), { denial }); await call('/api/ref/verifyRegistration'); await wait(() => text().includes('Email confirmed.'), 'Successful verification lost to storage'); assert(!win().location.hash, 'Sensitive token not scrubbed'); assert(!win().__uiErrors.length, `Verification storage errors: ${win().__uiErrors}`); return { denial, calls: (await control()).calls, hashScrubbed: true };
});
await run('storage-logout', async () => { await load('/referrals/dashboard', { denial: 'removeItem' }); await click('Log Out'); await call('/api/ref/logout'); await wait(() => win().location.pathname === '/referrals/login', 'Logout storage denial prevents navigation'); return { calls: (await control()).calls }; });
await run('storage-expired-session', async () => { await load('/referrals/dashboard', { denial: 'removeItem', mode: 'expired' }); await wait(() => win().location.pathname === '/referrals/login', 'Expired session failed to navigate'); assert(!win().__uiErrors.length, 'Expired storage throws'); return { calls: (await control()).calls }; });
for (const denial of ['setItem', 'quota']) await run(`payment-persistence-${denial}`, async () => {
  await load('/payment', { denial, seed: seedCheckout }); await wait(() => button('Pay your way') && !button('Pay your way').disabled, 'Dodo option unavailable'); await click('Pay your way'); await call('/api/payment/start'); await delay(350);
  assert(win().location.pathname === '/payment' && !(await control()).calls.some(c => c.hosted), 'Hosted navigation occurred without persisted recovery token'); assert(/storage|save.*session|browser.*save/i.test(text()), 'Recoverable persistence explanation absent'); assert(button('Check payment status'), 'In-memory payment recovery lost');
  win().history.pushState({ ...win().history.state, __rooLegacy: true }, '', '/payment?dodo_return=1'); win().dispatchEvent(new (win().PopStateEvent)('popstate', { state: win().history.state })); await delay(300); await click('Check payment status'); await wait(() => win().location.pathname === '/payment-success', 'Current-page status cannot recover session'); return { denial, calls: (await control()).calls, externalNavigationPrevented: true };
});
await run('payment-memory-terminal', async () => {
  await load('/payment', { denial: 'setItem', seed: seedCheckout, mode: 'failed' }); await wait(() => button('Pay your way') && !button('Pay your way').disabled, 'Dodo option unavailable'); await click('Pay your way'); await call('/api/payment/start'); await delay(250); assert(win().location.pathname === '/payment', 'Escaped payment on persistence failure'); win().__uiDenyStorage('removeItem'); await click('Check payment status'); await wait(() => text().includes('Payment was not completed and the slot was released.'), 'In-memory terminal cleanup skipped'); assert(!button('Check payment status'), 'Terminal in-memory session remains'); return { calls: (await control()).calls };
});
await run('payment-refresh-hold', async () => {
  await load('/payment', { denial: 'setItem', seed: seedCheckout }); await wait(() => button('Pay your way') && !button('Pay your way').disabled, 'Dodo unavailable'); await click('Pay your way'); await call('/api/payment/start'); await delay(250); assert(win().location.pathname === '/payment', 'Escaped payment'); await click('Change payment method'); await call('/api/payment/cancel'); await wait(() => text().includes('Payment method released.'), 'Denied refreshed-hold write masks successful cancel'); assert(!button('Check payment status'), 'Cancelled in-memory session remains'); return { calls: (await control()).calls };
});
await run('booking-hold-write', async () => {
  await load('/booking', { denial: 'setItem' }); await wait(() => [...doc().querySelectorAll('button')].find(n => n.textContent.includes('Earliest available:')), 'Earliest available fixture absent'); [...doc().querySelectorAll('button')].find(n => n.textContent.includes('Earliest available:')).click(); await click('Next'); await call('/api/holdSlot'); await wait(() => doc().querySelector('input[name=discord]'), 'Successful hold misreported after denied write'); assert(!text().includes('Could not reserve'), 'Server hold reported failed'); return { calls: (await control()).calls };
});
await run('booking-banner-release', async () => {
  const { hold } = await control(); await load('/terms', { seed: { my_slot_hold: hold } }); await wait(() => button('Release'), 'Banner release absent'); win().__uiDenyStorage('removeItem'); await click('Release'); const released = await call('/api/releaseHold'); assert(released.body.holdId === hold.holdId && released.body.holdToken === hold.holdToken, 'Actual held resource not released'); await wait(() => win().location.pathname === '/', 'Release did not navigate'); assert(!win().__uiErrors.length, 'Banner removal error escaped'); return { calls: (await control()).calls };
});
await run('booking-release-remove', async () => {
  const { hold } = await control(); await load('/booking', { denial: 'removeItem', seed: { my_slot_hold: hold } }); await wait(() => doc().querySelector('input[name=discord]'), 'Seed hold did not resume'); 
  const node = [...doc().querySelectorAll('button')].find(n => /Release|Cancel.*reservation|Change.*slot/i.test(n.textContent)); assert(node, 'Release control absent'); node.click(); await call('/api/releaseHold'); return { calls: (await control()).calls };
});
await run('booking-captured-remove', async () => {
  const { hold } = await control(); await load('/booking', { denial: 'removeItem', mode: 'captured', seed: { my_slot_hold: { ...hold, phase: 'payment_pending' }, checkout_booking_state: checkout, payment_session_state: { paymentAccessToken: 'payment-ui' } } });
  const node = await wait(() => [...doc().querySelectorAll('button')].find(n => /Change payment method|Release payment/i.test(n.textContent)), 'Pending payment release control absent'); node.click(); await call('/api/payment/cancel'); await wait(() => win().location.pathname === '/payment-success', 'Captured receipt lost to denied hold removal'); return { calls: (await control()).calls };
});
await run('booking-nested-dialog', async () => {
  await load('/booking'); const trigger = await wait(() => button('View My Plan'), 'ViewMyPlan absent'); trigger.focus(); trigger.click(); await delay(400);
  const overlay = doc().querySelector('.ri-booking.fixed.inset-0.z-\\[100\\]') || [...doc().querySelectorAll('[role=dialog]')].at(-1)?.parentElement; assert(overlay, 'Plan portal absent');
  const inner = overlay.querySelector('[role=dialog]') || overlay.firstElementChild; const close = inner.querySelector('button[aria-label=Close]'); close.focus();
  const key = (name, shiftKey = false) => close.dispatchEvent(new (win().KeyboardEvent)('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }));
  key('Tab'); assert(inner.contains(doc().activeElement), 'Plan Tab trapped behind top dialog'); key('Tab', true); assert(inner.contains(doc().activeElement), 'Plan ShiftTab trapped behind top dialog'); key('Escape'); await delay(350); assert(win().location.pathname === '/booking' && button('View My Plan'), 'Plan Escape closes outer booking'); assert(doc().activeElement === trigger, 'Plan close did not restore trigger focus'); trigger.click(); await delay(350);
  const backdrop = [...doc().querySelectorAll('[role=dialog]')].at(-1)?.parentElement; assert(backdrop, 'Plan dialog role absent'); backdrop.click(); await delay(350); assert(win().location.pathname === '/booking' && button('View My Plan'), 'Plan backdrop closes outer booking'); return { outerPreserved: true, focusRestored: true, nativeKeys: 'Separate trusted T3 sequence required' };
});
await run('bios-gigabyte', async () => {
  await load('/BIOSGuide/index.html'); const t = text(); assert(!t.includes('ASUS/MSI/Gigabyte:') && !t.includes('Main screen (unified)') && !t.includes('no separate EZ/Advanced') && !t.includes('Toggle EZ/Advanced Mode (ASUS, MSI, Gigabyte)'), 'Repeated wrong Gigabyte guidance remains');
  const relevant = [...doc().querySelectorAll('p,li,td')].filter(n => /Gigabyte/i.test(n.textContent) && /Mode|F2|F7|unified/.test(n.textContent)).map(n => n.textContent.trim()); assert(relevant.some(n => /F2/.test(n)) && relevant.some(n => /defaults/i.test(n)), 'Documented F2/defaults contract missing'); return { relevant, source: 'Gigabyte Intel800 BIOS pages4/5; no hardware actions; broader empirical claims unverified' };
});
await run('recovery-hash-only', async () => {
  await load('/referrals/reset', { seed: { referral_reset_token: 'e'.repeat(64) } });
  await wait(() => doc().querySelector('#ref-reset-new-password')?._valueTracker, 'Legacy form absent'); input('#ref-reset-new-password', 'Synthetic-password1!'); input('#ref-reset-confirm-password', 'Synthetic-password1!'); submit();
  await wait(() => /invalid or expired/i.test(text()), 'Expired legacy response absent');
  const value = await (await fetch('/__ui/control')).json();
  win().location.hash = `type=recovery&access_token=${value.session.access_token}&refresh_token=${value.session.refresh_token}`;
  await wait(() => !win().location.hash && doc().querySelector('#ref-reset-new-password') && !/invalid or expired/i.test(text()), 'Fresh hash recovery ignored or credentials not scrubbed');
  input('#ref-reset-new-password', 'Synthetic-password1!'); input('#ref-reset-confirm-password', 'Synthetic-password1!'); submit(); await call('/api/ref/recoverPassword');
  const calls = (await control()).calls; const fresh = calls.find(c => c.path === '/api/ref/recoverPassword'); assert(fresh.body.expectedUserId && fresh.body.expectedSessionId && !fresh.body.token, 'Recovery identity binding missing'); return { calls, sameDocument: true, scrubbed: true };
});
await run('recovery-stale-submit', async () => {
  await load('/referrals/reset', { mode: 'delayed-reset', seed: { referral_reset_token: 'e'.repeat(64) } });
  await wait(() => doc().querySelector('#ref-reset-new-password')?._valueTracker, 'Legacy form absent');
  input('#ref-reset-new-password', 'Synthetic-password1!'); input('#ref-reset-confirm-password', 'Synthetic-password1!'); submit(); await call('/api/ref/reset');
  const value = await (await fetch('/__ui/control')).json(); win().location.hash = `type=recovery&access_token=${value.session.access_token}&refresh_token=${value.session.refresh_token}`;
  await wait(() => !win().location.hash && doc().querySelector('#ref-reset-new-password') && !doc().querySelector('#ref-reset-new-password').value, 'New credentials did not initialize');
  const marker = sessionStorage.getItem('referral_recovery_session'); assert(marker, 'Fresh session marker absent'); await release('reset'); await delay(1800);
  assert(win().location.pathname === '/referrals/reset' && sessionStorage.getItem('referral_recovery_session') === marker && !text().includes('Password updated.'), 'Stale A completion changed fresh B state/navigation');
  return { oldCompletionIgnored: true, markerRetained: true, calls: (await control()).calls };
});
await run('payment-stale-terminal', async () => {
  await load('/payment', { denial: 'setItem', seed: seedCheckout, mode: 'failed' }); await wait(() => button('Pay your way') && !button('Pay your way').disabled, 'Dodo unavailable'); await click('Pay your way'); await call('/api/payment/start');
  await wait(() => button('Check payment status'), 'In-memory recovery absent'); const originalFetch = win().fetch; let releaseStatus; const gate = new Promise(resolve => { releaseStatus = resolve; }); win().fetch = async (...args) => { const response = await originalFetch(...args); if (String(args[0]).includes('/api/payment/finalize')) await gate; return response; };
  await click('Check payment status'); await call('/api/payment/finalize'); win().__uiDenyStorage(''); const newer = { paymentAccessToken: 'newer-token', provider: 'dodo', fingerprint: 'quote-ui', providerPayload: { checkoutUrl: location.origin + '/__ui/hosted/checkout' } }; win().sessionStorage.setItem('payment_session_state', JSON.stringify(newer)); releaseStatus(); await delay(600);
  const stored = JSON.parse(win().sessionStorage.getItem('payment_session_state') || 'null'); assert(stored?.paymentAccessToken === 'newer-token', 'Stale A terminal removed persisted B session'); return { stored, staleCleanupRefused: true, calls: (await control()).calls };
});
await run('booking-native-ready', async () => {
  const { hold } = await control(); await load('/booking', { seed: { my_slot_hold: hold } });
  await wait(() => doc().querySelector('input[name=discord]'), 'Native preparation details absent'); input('input[name=discord]', 'native-draft'); await click('Back');
  await wait(() => button('View My Plan'), 'Native preparation plan absent'); return { ready: true, hold };
});
await save(true); window.__uiRepairsComplete = true; window.__uiRepairsResults = results;
