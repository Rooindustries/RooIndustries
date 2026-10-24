const RAM_PRICE_SOURCE = Object.freeze({
  name: 'v-color',
  endpoint: 'https://v-color.net/api/2026-07/graphql.json',
  productId: 'gid://shopify/Product/8511039242407',
  variantId: 'gid://shopify/ProductVariant/46736066052263',
  sku: 'TMXFL1660830KWK',
  handle: 'ddr5-manta-xfinity-rgb-gaming-memory-copy',
  url: 'https://v-color.net/products/ddr5-manta-xfinity-rgb-gaming-memory-copy?variant=46736066052263',
});
const RAM_PRICE_WINDOW_MS = 6 * 60 * 60 * 1000;

const isVerifiedRamPrice = (value, now = Date.now()) => {
  const checkedAt = Date.parse(value?.checkedAt);
  return Boolean(value && Number.isSafeInteger(value.priceCents) && value.priceCents >= 2500 && value.priceCents <= 150000 &&
    value.currency === 'USD' && value.source === RAM_PRICE_SOURCE.name && value.sourceUrl === RAM_PRICE_SOURCE.url &&
    value.variantId === RAM_PRICE_SOURCE.variantId && value.sku === RAM_PRICE_SOURCE.sku &&
    Number.isFinite(checkedAt) && checkedAt > 0 && checkedAt <= now + 300000 && new Date(checkedAt).toISOString() === value.checkedAt);
};

const formatRamPrice = value => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: value % 100 === 0 ? 0 : 2,
}).format(value / 100);

const ramPriceSourceLabel = value => `${RAM_PRICE_SOURCE.name}, checked ${new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(new Date(value.checkedAt))}`;

module.exports = { RAM_PRICE_SOURCE, RAM_PRICE_WINDOW_MS, isVerifiedRamPrice, formatRamPrice, ramPriceSourceLabel };
