const { heroDescription, resolveHeroCopy: resolveBaseHeroCopy } = require('./homeCopy');
const { isVerifiedRamPrice, formatRamPrice, ramPriceSourceLabel } = require('./ramPrice');
const { isTopPackageTitle, getPackagePricePresentation, toMoney } = require('./packagePricing');

const getHeroTunePrice = (packages) => {
  const max = Array.isArray(packages) ? packages.find(pkg => isTopPackageTitle(pkg?.title)) : null;
  if (!max || !['string', 'number'].includes(typeof max.price) || toMoney(max.price) <= 0) return '';
  const price = getPackagePricePresentation(max.title, max.price).price;
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
