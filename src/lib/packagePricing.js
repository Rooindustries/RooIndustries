const PRICE_OVERRIDES = [
  {
    titlePattern: /^vertex essentials$/i,
    compareAtPrice: "$49.95",
    price: "$29.95",
  },
  {
    titlePattern: /^performance vertex overhaul$/i,
    compareAtPrice: "$79.95",
    price: "$54.95",
  },
  {
    titlePattern: /^xoc(?:\s*\/\s*extreme overclocking)?$/i,
    compareAtPrice: "$179.95",
    price: "$149.95",
  },
];

const toMoney = (value) => {
  const parsed = Number(
    typeof value === "string" ? value.replace(/[^0-9.]/g, "") : value
  );
  if (!Number.isFinite(parsed)) return 0;
  return +parsed.toFixed(2);
};

const sameMoney = (left, right) => toMoney(left) === toMoney(right);

const findPriceOverride = (title = "") =>
  PRICE_OVERRIDES.find((entry) =>
    entry.titlePattern.test(String(title || "").trim())
  ) || null;

const shouldApplyOverride = (override, sourcePrice) => {
  if (!override) return false;
  if (!sourcePrice) return true;
  return (
    sameMoney(sourcePrice, override.compareAtPrice) ||
    sameMoney(sourcePrice, override.price)
  );
};

const getPackagePricePresentation = (title = "", sourcePrice = "") => {
  const override = findPriceOverride(title);
  if (!shouldApplyOverride(override, sourcePrice)) {
    return {
      price: sourcePrice || "",
      compareAtPrice: "",
      hasOverride: false,
    };
  }

  return {
    price: override.price,
    compareAtPrice: override.compareAtPrice,
    hasOverride: true,
  };
};

const applyPackagePricing = (pkg) => {
  if (!pkg || typeof pkg !== "object") return pkg;

  const pricing = getPackagePricePresentation(pkg.title, pkg.price);
  if (!pricing.hasOverride) return pkg;

  return {
    ...pkg,
    price: pricing.price,
    originalPrice: pricing.compareAtPrice,
    compareAtPrice: pricing.compareAtPrice,
  };
};

const applyPackagesPricing = (packages) =>
  Array.isArray(packages) ? packages.map(applyPackagePricing) : packages;

const api = {
  PRICE_OVERRIDES,
  applyPackagePricing,
  applyPackagesPricing,
  getPackagePricePresentation,
  toMoney,
};

module.exports = api;
module.exports.default = api;
