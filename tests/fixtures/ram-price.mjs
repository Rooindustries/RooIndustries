import homeCopy from '../../src/lib/homeCopy.js';
import { createHmac, randomUUID } from 'node:crypto';

export function createRamPriceFixture({ documents, cronSecret = 'fixture-only-ram-price-cron' }) {
  let state;
  const receipts = new Map();
  const bucket = createHmac('sha256', cronSecret).update('hero-ram-price').digest('hex');
  const hero = () => documents.find(document => document._type === 'hero');
  Object.assign(hero(), homeCopy.HOME_COPY.hero);
  const initialHero = structuredClone(hero());
  const maxPackageId = documents.find(document => document._type === 'package' && /max|xoc/i.test(document.title))?._id;
  const maxPackage = () => documents.find(document => document._id === maxPackageId);
  const initialPackagePrice = maxPackage()?.price;
  const quote = (priceCents, checkedAt = new Date(Date.now() - 7 * 3600000).toISOString()) => ({
    priceCents, checkedAt, currency: 'USD', source: 'v-color',
    sourceUrl: 'https://v-color.net/products/ddr5-manta-xfinity-rgb-gaming-memory-copy?variant=46736066052263',
    sku: 'TMXFL1660830KWK', variantId: 'gid://shopify/ProductVariant/46736066052263',
  });
  const reset = () => {
    state = { mode: 'normal', price: '500.00', reads: 0, publishes: [], revisions: [], limits: new Set(), race: false, lostReceipt: false };
    receipts.clear();
    const currentHero = hero();
    for (const key of Object.keys(currentHero)) delete currentHero[key];
    Object.assign(currentHero, structuredClone(initialHero));
    if (maxPackage()) maxPackage().price = initialPackagePrice;
  };
  reset();
  const json = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(value));
  };
  return async ({ url, body, res }) => {
    if (url.pathname === '/__ram-price') {
      if (body.reset) reset();
      for (const name of ['mode', 'price', 'race', 'lostReceipt']) if (body[name] !== undefined) state[name] = body[name];
      if (body.previousPrice !== undefined) hero().ramPrice = quote(body.previousPrice, body.checkedAt);
      json(res, 200, { ...state, limits: [...state.limits], hero: hero(), packages: documents.filter(document => document._type === 'package') });
      return true;
    }
    if (url.pathname === '/storefront') {
      state.reads++;
      if (!body.query?.includes('gid://shopify/ProductVariant/46736066052263') || !body.query.includes('country: US')) throw new Error('Unpinned Storefront query.');
      if (state.mode === 'failed') { json(res, 503, { error: 'Synthetic source outage' }); return true; }
      if (state.mode === 'malformed') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{'); return true; }
      if (state.mode === 'oversized') { json(res, 200, { padding: 'x'.repeat(70000) }); return true; }
      if (state.mode === 'slow') {
        await new Promise(resolve => { const timer = setTimeout(resolve, 25000); res.once('close', () => { clearTimeout(timer); resolve(); }); });
        if (res.destroyed) return true;
      }
      const variant = {
        id: 'gid://shopify/ProductVariant/46736066052263', sku: 'TMXFL1660830KWK',
        availableForSale: true, currentlyNotInStock: false,
        requiresComponents: false, quantityRule: { minimum: 1, maximum: null, increment: 1 },
        price: { amount: state.price, currencyCode: 'USD' },
        selectedOptions: [
          { name: 'Memory Capacity', value: '32GB (2x16GB)' },
          { name: 'Memory Frequency', value: '6000MHz ◼Intel XMP / AMD E.X.P.O' },
          { name: 'Color', value: 'Black' },
        ],
        product: { id: 'gid://shopify/Product/8511039242407', handle: 'ddr5-manta-xfinity-rgb-gaming-memory-copy', vendor: 'v-color', onlineStoreUrl: quote(50000).sourceUrl.split('?')[0], requiresSellingPlan: false },
      };
      if (state.mode === 'unavailable') variant.availableForSale = false;
      if (state.mode === 'backorder') variant.currentlyNotInStock = true;
      if (state.mode === 'wrong-sku') variant.sku = 'ANOTHER-KIT';
      if (state.mode === 'wrong-variant') variant.id = 'gid://shopify/ProductVariant/1';
      if (state.mode === 'wrong-product') variant.product.id = 'gid://shopify/Product/1';
      if (state.mode === 'wrong-options') variant.selectedOptions[0].value = '64GB (2x32GB)';
      if (state.mode === 'wrong-currency') variant.price.currencyCode = 'EUR';
      if (state.mode === 'missing-price') delete variant.price;
      if (state.mode === 'bulk-only') variant.quantityRule.minimum = 2;
      if (state.mode === 'bundle-only') variant.requiresComponents = true;
      if (state.mode === 'subscription') variant.product.requiresSellingPlan = true;
      const data = { localization: { country: { isoCode: state.mode === 'wrong-market' ? 'GB' : 'US', currency: { isoCode: 'USD' } } }, node: state.mode === 'missing' ? null : variant };
      const headers = {};
      if (state.mode === 'stale') headers.Date = new Date(Date.now() - 86400000).toUTCString();
      if (state.mode === 'future') headers.Date = new Date(Date.now() + 86400000).toUTCString();
      if (state.mode === 'cached') headers.Age = '86400';
      json(res, 200, { data, ...(state.mode === 'graphql-error' ? { errors: [{ message: 'Synthetic access denied' }] } : {}) }, headers);
      return true;
    }
    if (url.pathname === '/rest/v1/rpc/roo_consume_rate_limit' && body.p_bucket_key_hmac === bucket) {
      if (state.mode === 'limiter-down') { json(res, 503, { code: 'XX000', message: 'Synthetic limiter outage' }); return true; }
      const key = `${body.p_bucket_key_hmac}:${body.p_window_started_at}`;
      const allowed = !state.limits.has(key);
      state.limits.add(key);
      json(res, 200, { allowed });
      return true;
    }
    if (url.pathname === '/rest/v1/rpc/roo_cms_document_revisions' && body.p_document_id === hero()._id) {
      json(res, 200, state.revisions);
      return true;
    }
    if (['/rest/v1/rpc/roo_cms_publish_command_result', '/rest/v1/rpc/roo_apply_cms_publish_command'].includes(url.pathname) && body.p_actor !== 'admin:cron-hero-ram-price') return false;
    if (['/rest/v1/rpc/roo_cms_publish_command_result', '/rest/v1/rpc/roo_apply_cms_publish_command'].includes(url.pathname) &&
        (!/^(sanity|admin):[A-Za-z0-9._@/-]{1,120}$/.test(body.p_actor || '') ||
         !/^cms:[0-9a-f]{64}$/.test(body.p_command_id || '') || body.p_command_id.slice(4) !== body.p_request_hash)) {
      json(res, 400, { code: '22023', message: 'Invalid CMS command identity.' });
      return true;
    }
    if (url.pathname === '/rest/v1/rpc/roo_cms_publish_command_result') {
      const saved = receipts.get(body.p_command_id);
      if (saved && (saved.actor !== body.p_actor || saved.hash !== body.p_request_hash)) {
        json(res, 409, { code: '40001', message: 'CMS command identity conflict.' });
        return true;
      }
      json(res, 200, saved ? { ...saved.receipt, replayed: true } : null);
      return true;
    }
    if (url.pathname === '/rest/v1/rpc/roo_apply_cms_publish_command') {
      if (state.mode === 'publish-timeout') {
        await new Promise(resolve => { const timer = setTimeout(resolve, 25000); res.once('close', () => { clearTimeout(timer); resolve(); }); });
        res.destroy();
        return true;
      }
      if (state.mode === 'publish-failed') { json(res, 503, { code: 'XX000', message: 'Synthetic CMS outage' }); return true; }
      if (state.race) { hero().headingLine1 = 'Concurrent editor headline'; hero()._rev = 'concurrent-editor'; state.race = false; }
      const mutation = body.p_mutations?.[0];
      if (body.p_mutations?.length !== 1 || mutation?.id !== hero()._id || mutation.operation !== 'replace') throw new Error('Refresh tried to publish other content.');
      if (mutation.expected_revision !== hero()._rev) { json(res, 409, { code: '40001', message: 'CMS_REVISION_CONFLICT' }); return true; }
      const changed = Object.keys(mutation.document).filter(key => !key.startsWith('_') && JSON.stringify(mutation.document[key]) !== JSON.stringify(hero()[key]));
      if (changed.length !== 1 || changed[0] !== 'ramPrice') throw new Error('Refresh changed a field other than ramPrice.');
      state.revisions.push({ revisionId: randomUUID(), createdAt: new Date().toISOString(), actor: body.p_actor, operation: mutation.operation });
      Object.assign(hero(), mutation.document, { _rev: `ram-price-${state.publishes.length + 1}` });
      hero().ramPrice = Object.fromEntries(Object.entries(hero().ramPrice).sort(([left], [right]) => left.localeCompare(right)));
      state.publishes.push(structuredClone(mutation));
      const receipt = { command_id: body.p_command_id, operation: mutation.operation, document_ids: [hero()._id], replayed: false, results: [{ _id: hero()._id, _type: 'hero', _rev: hero()._rev }] };
      receipts.set(body.p_command_id, { receipt, actor: body.p_actor, hash: body.p_request_hash });
      if (state.lostReceipt) { state.lostReceipt = false; json(res, 503, { code: 'XX000', message: 'Synthetic lost response' }); return true; }
      if (state.mode === 'commit-timeout') {
        await new Promise(resolve => { const timer = setTimeout(resolve, 25000); res.once('close', () => { clearTimeout(timer); resolve(); }); });
        if (res.destroyed) return true;
      }
      json(res, 200, receipt);
      return true;
    }
    return false;
  };
}
