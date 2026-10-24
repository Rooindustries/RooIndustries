import crypto from 'node:crypto';
import { isIP } from 'node:net';
import ramPrice from '../../lib/ramPrice.js';
import { fetchShadowDocuments } from '../supabase/shadowStore.js';
import { executeGlobalCmsCommand } from '../cms/publishCommand.js';
import { getSafeErrorMetadata, logSafeWarn } from '../safeErrorLog.js';

const { RAM_PRICE_SOURCE: source, RAM_PRICE_WINDOW_MS, isVerifiedRamPrice } = ramPrice;
const failure = code => Object.assign(new Error('The RAM price could not be verified.'), { code, status: 503 });
const query = `query @inContext(country: US) {
  localization { country { isoCode currency { isoCode } } }
  node(id: "${source.variantId}") { ... on ProductVariant {
    id sku availableForSale currentlyNotInStock price { amount currencyCode }
    quantityRule { minimum maximum increment } requiresComponents
    selectedOptions { name value } product { id handle vendor onlineStoreUrl requiresSellingPlan }
  } }
}`;

const sourceEndpoint = env => {
  const configured = env.HERO_RAM_PRICE_SOURCE_URL;
  if (env.VERCEL_ENV === 'production') {
    if (env.CI || configured && configured !== source.endpoint) throw failure('RAM_PRICE_PRODUCTION_GUARD');
    return source.endpoint;
  }
  if (!configured || env.TOOLING_NETWORK_GUARD !== '1') throw failure('RAM_PRICE_PREVIEW_DISABLED');
  const url = new URL(configured);
  const host = url.hostname;
  const privateHost = isIP(host) === 4 && (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host));
  if (url.protocol !== 'http:' || !privateHost || !url.port || url.username || url.password || url.search || url.hash) throw failure('RAM_PRICE_FIXTURE_GUARD');
  return url.href;
};

const fetchQuote = async ({ env, signal, now }) => {
  const response = await fetch(sourceEndpoint(env), {
    method: 'POST', redirect: 'error', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'RooIndustries-RamPrice/1.0 (+https://www.rooindustries.com)' },
    body: JSON.stringify({ query }),
  });
  if (response.status !== 200 || !/^application\/json\b/i.test(response.headers.get('content-type') || '')) throw failure('RAM_PRICE_SOURCE_UNAVAILABLE');
  const date = Date.parse(response.headers.get('date'));
  const age = response.headers.get('age');
  if (!Number.isFinite(date) || now - date > 900000 || date - now > 300000 || age !== null && (!/^\d+$/.test(age) || Number(age) > 300)) throw failure('RAM_PRICE_STALE_SOURCE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); throw failure('RAM_PRICE_SOURCE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('RAM_PRICE_INVALID_SOURCE'); }
  const variant = result?.data?.node;
  const product = variant?.product;
  const market = result?.data?.localization?.country;
  if (result.errors !== undefined || market?.isoCode !== 'US' || market?.currency?.isoCode !== 'USD' ||
      variant?.id !== source.variantId || variant.sku !== source.sku || product?.id !== source.productId ||
      product.handle !== source.handle || product.vendor !== source.name || product.onlineStoreUrl !== source.url.split('?')[0] || product.requiresSellingPlan !== false ||
      variant.availableForSale !== true || variant.currentlyNotInStock !== false || variant.price?.currencyCode !== 'USD') throw failure('RAM_PRICE_SOURCE_MISMATCH');
  if (variant.requiresComponents !== false || variant.quantityRule?.minimum !== 1 || variant.quantityRule?.increment !== 1 ||
      variant.quantityRule.maximum !== null && (!Number.isSafeInteger(variant.quantityRule.maximum) || variant.quantityRule.maximum < 1) ||
      result.extensions?.context?.country && result.extensions.context.country !== 'US') throw failure('RAM_PRICE_NOT_RETAIL_KIT');
  const options = variant.selectedOptions;
  const expected = { 'Memory Capacity': '32GB (2x16GB)', 'Memory Frequency': '6000MHz ◼Intel XMP / AMD E.X.P.O', Color: 'Black' };
  if (!Array.isArray(options) || options.length !== 3 || Object.entries(expected).some(([name, value]) => options.filter(option => option.name === name && option.value === value).length !== 1)) throw failure('RAM_PRICE_WRONG_KIT');
  const amount = variant.price.amount;
  if (typeof amount !== 'string' || !/^\d{1,4}(?:\.\d{1,2})?$/.test(amount)) throw failure('RAM_PRICE_INVALID_AMOUNT');
  const value = {
    priceCents: Math.round(Number(amount) * 100), currency: 'USD', checkedAt: new Date(now).toISOString(),
    source: source.name, sourceUrl: source.url, sku: source.sku, variantId: source.variantId,
  };
  if (!isVerifiedRamPrice(value, now)) throw failure('RAM_PRICE_IMPLAUSIBLE_AMOUNT');
  return value;
};

const loadHero = async client => {
  const documents = await fetchShadowDocuments({ client, documentTypes: ['hero'], limit: 2, allowLegacyFallback: false });
  if (documents.length !== 1 || !documents[0]._rev) throw failure('RAM_PRICE_HERO_UNAVAILABLE');
  return documents[0];
};

export async function refreshRamPrice({ client, env = process.env, signal, now = Date.now() }) {
  sourceEndpoint(env);
  const windowStart = Math.floor(now / RAM_PRICE_WINDOW_MS) * RAM_PRICE_WINDOW_MS;
  let current = await loadHero(client);
  if (current.ramPrice && !isVerifiedRamPrice(current.ramPrice, now)) throw failure('RAM_PRICE_INVALID_HISTORY');
  if (current.ramPrice && Date.parse(current.ramPrice.checkedAt) >= windowStart) return { state: 'fresh', checkedAt: current.ramPrice.checkedAt };
  const { data, error } = await client.rpc('roo_consume_rate_limit', {
    p_bucket_key_hmac: crypto.createHmac('sha256', env.CRON_SECRET).update('hero-ram-price').digest('hex'),
    p_window_started_at: new Date(windowStart).toISOString(),
    p_reset_at: new Date(windowStart + RAM_PRICE_WINDOW_MS).toISOString(), p_max: 1,
  });
  if (error || typeof data?.allowed !== 'boolean') throw failure('RAM_PRICE_LIMITER_UNAVAILABLE');
  if (!data.allowed) return { state: 'limited', retryAfter: Math.ceil((windowStart + RAM_PRICE_WINDOW_MS - now) / 1000) };
  const quote = await fetchQuote({ env, signal, now });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (current.ramPrice && Math.abs(quote.priceCents - current.ramPrice.priceCents) * 100 > current.ramPrice.priceCents * 30) throw failure('RAM_PRICE_OUTLIER');
    try {
      await executeGlobalCmsCommand({
        supabaseClient: client, env, actor: 'cron:hero-ram-price',
        body: { operation: 'replace', type: 'hero', documentId: current._id, expectedRevision: current._rev, document: { ...current, ramPrice: quote } },
      });
      return { state: 'updated', checkedAt: quote.checkedAt };
    } catch (error) {
      const latest = await loadHero(client);
      if (latest.ramPrice && Object.keys(quote).every(key => latest.ramPrice[key] === quote[key])) return { state: 'updated', checkedAt: quote.checkedAt };
      if (error.code !== 'CMS_REVISION_CONFLICT' || attempt > 0) throw error;
      if (latest.ramPrice && !isVerifiedRamPrice(latest.ramPrice, now)) throw failure('RAM_PRICE_INVALID_HISTORY');
      if (latest.ramPrice && Date.parse(latest.ramPrice.checkedAt) >= windowStart) return { state: 'fresh', checkedAt: latest.ramPrice.checkedAt };
      current = latest;
    }
  }
}

export function reportRamPriceFailure(error) {
  const label = 'RAM price refresh failed; last verified price retained';
  logSafeWarn(label, error);
  globalThis[Symbol.for('roo.reportServerError')]?.(label, error, {
    ...getSafeErrorMetadata(error), name: 'RamPriceRefreshError', level: 'warning',
  });
}
