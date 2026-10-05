import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export function uiRepairsFixture({ json, read, base }) {
  let state = { active: false, scenario: '', mode: '', denial: '', seed: {}, calls: [] };
  const pending = new Map();
  const packageData = { title: 'Performance Vertex Overhaul', price: '$84.99', features: ['Synthetic feature'], buttonText: 'Book Now' };
  const hold = { holdId: 'hold-ui', holdToken: 'hold-token-ui', expiresAt: new Date(Date.now() + 3600000).toISOString(), startTimeUTC: '2099-01-05T04:30:00.000Z', packageTitle: packageData.title, packagePrice: packageData.price, phase: 'active' };
  const creator = { creator_id: 'creator-ui', referral_code: 'synthetic', name: 'Synthetic creator', creator_email: 'ui@fixture.invalid', total_basis_points: 2000, commission_basis_points: 500, discount_basis_points: 1500, bypass_referral_requirement: false, successful_referrals: 0, terms_version: 1 };
  const upgrade = { ok: true, booking: { _id: 'orderA', packageTitle: packageData.title, ...hold }, xoc: { title: 'Performance Vertex Max', price: 149.99 }, targetPackage: { title: 'Performance Vertex Max', price: 149.99, priceString: '$149.99' }, originalPaid: 84.99, upgradePrice: 65, upgradeIntentToken: 'intentA' };
  const hrefs = ['https://www.rooindustries.com/privacy', 'https://www.rooindustries.com/terms', 'mailto:help@legitimate.invalid', '/contact', 'mailto:serviroo@rooindustries.com', 'https://example.invalid/rooindustries.com'];
  const policy = { title: 'Synthetic policy', sections: [{ heading: 'Links', content: [{ _type: 'block', _key: 'links', style: 'normal', markDefs: hrefs.map((href, i) => ({ _type: 'link', _key: `link${i}`, href })), children: hrefs.map((href, i) => ({ _type: 'span', _key: `span${i}`, marks: [`link${i}`], text: `fixture-link${i} ` })) }] }] };
  const content = (resource, url) => {
    if (resource === 'contact') return { title: 'Synthetic contact', email: 'ui@fixture.invalid', formId: 'formB' };
    if (resource === 'upgrade-link') return { title: `Upgrade ${url.searchParams.get('slug')}`, targetPackage: upgrade.targetPackage };
    if (resource === 'terms' || resource === 'privacy-policy') return policy;
    if (resource === 'supported-games') return { title: 'Synthetic games', featuredGames: state.mode === 'populated' ? [{ _key: 'featured', title: 'Featured game' }] : [], moreGames: [{ _key: 'extra', title: 'Extra game' }] };
    if (resource === 'reviews') return { title: 'Synthetic reviews', reviews: [1, 3, 5, 5].map((rating, i) => ({ _id: `review${i}`, name: `Reviewer ${i}`, text: 'Synthetic review text', rating })) };
    if (resource === 'faq-questions') { const file = require.resolve('../../src/lib/policyContent.js'); delete require.cache[file]; return require(file).applyFaqPolicyOverrides([{ _id: 'warranty-ui', question: 'Do you offer a money-back guarantee? What is the warranty?', answer: 'Synthetic old warranty' }]); }
    if (resource === 'package') return packageData;
    if (resource === 'packages-list') return [packageData, { title: 'Performance Vertex Max', price: '$149.99', features: ['Synthetic max feature'] }];
    if (resource === 'faq-settings') return { title: 'FAQ' };
    if (resource === 'global' || resource === 'global-content' || resource === 'packages-settings') return {};
    return null;
  };
  return {
    content,
    active: () => state.active,
    bootstrap: () => JSON.stringify({ denial: state.denial, seed: state.seed }),
    transform: html => html.replace(/<script>self\.__next_f\.push\((\[1,"(?:\\.|[^"\\])*"\])\)<\/script>/g, (original, argument) => {
      try {
        const payload = JSON.parse(argument);
        const encodeFlight = value => typeof value === 'string' && value.startsWith('$') ? '$' + value : Array.isArray(value) ? value.map(encodeFlight) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeFlight(item)])) : value;
        const update = value => {
          if (!value || typeof value !== 'object') return;
          if ('initialHomeData' in value) value.initialHomeData = encodeFlight({ reviews: content('reviews', new URL(base)), supportedGames: content('supported-games', new URL(base)), faqQuestions: content('faq-questions', new URL(base)), packagesList: content('packages-list', new URL(base)), faqSettings: { title: 'FAQ' } });
          Object.values(value).forEach(update);
        };
        payload[1] = payload[1].split('\n').map(line => {
          const colon = line.indexOf(':');
          try { const value = JSON.parse(line.slice(colon + 1)); update(value); return line.slice(0, colon + 1) + JSON.stringify(value); } catch { return line; }
        }).join('\n');
        return '<script>self.__next_f.push(' + JSON.stringify(payload).replace(/</g, '\\u003c') + ')</script>';
      } catch { return original; }
    }),
    async handle(req, res, url) {
      const p = url.pathname;
      if (p === '/__ui') { state.active = false; return false; }
      if (p === '/__ui/repairs') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Roo UI repairs</title><main><h1 hidden>Named UI repair scenarios</h1><pre id="results" hidden></pre><iframe id="app" title="Actual application" style="position:fixed;inset:0;width:100%;height:100vh;border:0"></iframe></main><script type="module" src="/__ui/repairs-runner.js"></script>'); return true; }
      if (p === '/__ui/repairs-runner.js' || p === '/__ui/repairs-init.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(p.endsWith('init.js') ? 'tests/fixtures/ui-repairs-init.js' : 'tests/fixtures/ui-repairs-browser.mjs')); return true; }
      if (p === '/__ui/repairs-control') {
        if (req.method === 'POST') { const body = await read(req); state = { active: true, scenario: body.scenario || '', mode: body.mode || '', denial: body.denial || '', seed: body.seed || {}, calls: [] }; }
        json(res, { ...state, hold, creator, hrefs }); return true;
      }
      if (p === '/__ui/repairs-release') {
        const key = url.searchParams.get('key'); const entry = pending.get(key);
        if (entry) { pending.delete(key); json(entry.res, entry.body); }
        json(res, { released: Boolean(entry) }); return true;
      }
      if (p === '/__ui/repairs-evidence') {
        const body = await read(req); const phase = body.phase === 'before' ? 'before' : 'after'; const scenario = String(body.scenario || 'all').replace(/[^a-z0-9-]/g, '');
        const artifact = path.resolve(`test-results/ui-repairs-${phase}-${scenario}.json`); fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, JSON.stringify(body, null, 2)); json(res, { saved: artifact }); return true;
      }
      if (p.startsWith('/__ui/hosted/')) { state.calls.push({ path: p, hosted: true }); res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Synthetic hosted checkout</title><a href="/payment?dodo_return=1">Synthetic return</a>'); return true; }
      if (p === '/__ui/formspree') { let body = ''; for await (const chunk of req) body += chunk; state.calls.push({ path: p, form: url.searchParams.get('form'), bodyPresent: body.includes('Synthetic message') }); json(res, { next: `${base}/contact` }); return true; }
      if (!state.active) return false;
      if (p.startsWith('/api/content/')) {
        const resource = decodeURIComponent(p.split('/').pop()); state.calls.push({ path: p, slug: url.searchParams.get('slug') });
        const body = { ok: true, data: content(resource, url) };
        if (resource === 'contact' && state.mode === 'delayed') { pending.set('contact', { res, body }); return true; }
        json(res, body); return true;
      }
      if (!p.startsWith('/api/')) return false;
      const body = req.method === 'POST' || req.method === 'PATCH' ? await read(req) : {};
      state.calls.push({ path: p, method: req.method, body });
      if (p === '/api/ref/getUpgradeInfo') { pending.set('upgrade', { res, body: { ...upgrade, booking: { ...upgrade.booking, _id: body.id }, upgradeIntentToken: `intent-${body.id}` } }); return true; }
      if (p === '/api/admin/referral-creators') {
        if (req.method === 'PATCH') { pending.set('editor', { res, body: { creator: { ...creator, total_basis_points: Number(body.totalPercent) * 100, commission_basis_points: Number(body.commissionPercent) * 100, discount_basis_points: Number(body.discountPercent) * 100, terms_version: 2 }, syncPending: false } }); return true; }
        json(res, url.searchParams.has('creatorId') ? { history: [] } : { creators: [creator], hasMore: false }); return true;
      }
      if (p === '/api/auth/identities') { json(res, { authenticated: false }); return true; }
      if (p === '/api/ref/reset') { if (state.mode === 'delayed-reset') { pending.set('reset', { res, body: { ok: true, status: 'updated' } }); return true; } json(res, { ok: false, error: 'Invalid or expired token.' }, 400); return true; }
      if (p === '/api/ref/recoverPassword') { json(res, { ok: true, status: 'updated' }); return true; }
      if (p === '/api/ref/sessionStatus') { json(res, { authenticated: false }); return true; }
      if (p === '/api/ref/login') { json(res, { ok: true, code: 'synthetic' }); return true; }
      if (p === '/api/ref/register') { json(res, { ok: true, pendingVerification: true }); return true; }
      if (p === '/api/ref/verifyRegistration') { json(res, { ok: true }); return true; }
      if (p === '/api/ref/getData') { json(res, state.mode === 'expired' ? { ok: false } : { ok: true, referral: { name: 'Synthetic creator', slug: 'synthetic', code: 'synthetic', successfulReferrals: 0 } }); return true; }
      if (p === '/api/ref/payouts') { json(res, { ok: true }); return true; }
      if (p === '/api/ref/logout') { json(res, { ok: true }); return true; }
      if (p === '/api/ref/validateReferral') { json(res, { ok: false, reason: 'available' }); return true; }
      if (p === '/api/bookingAvailability') { json(res, { settings: { dateSlots: [{ date: '2099-01-05', times: ['10:00', '11:00'] }], timeZone: 'Asia/Kolkata' }, bookedSlots: [] }); return true; }
      if (p === '/api/holdSlot') { json(res, { ok: true, ...hold, startTimeUTC: body.startTimeUTC }); return true; }
      if (p === '/api/releaseHold') { json(res, { ok: true }); return true; }
      if (p === '/api/payment/quote') { json(res, { ok: true, quote: { netAmount: 84.99, isFree: false }, quoteFingerprint: 'quote-ui', providers: { dodo: { enabled: true }, paypal: { enabled: false }, razorpay: { enabled: false } } }); return true; }
      if (p === '/api/payment/start') { json(res, { ok: true, paymentAccessToken: 'payment-ui', providerPayload: { checkoutUrl: `${base}/__ui/hosted/checkout`, taxInclusive: false }, sessionExpiresAt: hold.expiresAt, status: 'started' }); return true; }
      if (p === '/api/payment/finalize' || p === '/api/payment/status') { json(res, state.mode === 'failed' ? { ok: true, status: 'failed' } : { ok: true, status: 'booked', bookingId: 'receipt-ui', emailDispatchToken: 'receipt-token-ui' }); return true; }
      if (p === '/api/payment/cancel') { json(res, state.mode === 'captured' ? { ok: true, captured: true, status: 'booked', bookingId: 'receipt-ui', emailDispatchToken: 'receipt-token-ui' } : { ok: true, cancelled: true, refreshedHold: { slotHoldId: 'hold-refreshed', slotHoldToken: 'hold-refreshed-token', slotHoldExpiresAt: hold.expiresAt } }); return true; }
      json(res, { ok: false, error: 'Synthetic UI fixture refuses this endpoint.' }, 503); return true;
    }
  };
}
