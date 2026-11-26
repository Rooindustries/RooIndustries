const { heroDescription, resolveHeroCopy: resolveBaseHeroCopy } = require('./homeCopy');
const { isVerifiedRamPrice, formatRamPrice, ramPriceSourceLabel } = require('./ramPrice');
const { getPackagePricePresentation, toMoney } = require('./packagePricing');
const { OVERHAUL_TITLE_PATTERN } = require('./packageContent');

const getHeroTunePrice = (packages) => {
  const overhaul = Array.isArray(packages)
    ? packages.find(pkg => OVERHAUL_TITLE_PATTERN.test(String(pkg?.title || '').trim()))
    : null;
  if (!overhaul || !['string', 'number'].includes(typeof overhaul.price) || toMoney(overhaul.price) <= 0) return '';
  const price = getPackagePricePresentation(overhaul.title, overhaul.price).price;
  return toMoney(price) > 0 ? price : '';
};

const resolveHeroCopy = (value, packages = []) => {
  const copy = resolveBaseHeroCopy(value);
  if (!isVerifiedRamPrice(value?.ramPrice)) return copy;
  const ramPrice = value.ramPrice;
  const amount = formatRamPrice(ramPrice.priceCents);
  const tunePrice = getHeroTunePrice(packages);
  return {
    ...copy,
    ramPrice,
    ramPriceSourceLabel: ramPriceSourceLabel(ramPrice),
    headingLine1: `Why Pay ${amount} For RAM?`,
    headingLine2: toMoney(tunePrice) > 0 ? `Tune Yours For ${tunePrice}.` : 'Tune Yours.',
    description: heroDescription(amount),
  };
};

module.exports = { getHeroTunePrice, resolveHeroCopy };
