const TOP_PACKAGE_PUBLIC_TITLE = "Performance Vertex Max";
const TOP_PACKAGE_LEGACY_TITLE = "XOC / Extreme Overclocking";
const TOP_PACKAGE_TITLE_ALIASES = [
  TOP_PACKAGE_PUBLIC_TITLE,
  TOP_PACKAGE_LEGACY_TITLE,
  "XOC",
];
const TOP_PACKAGE_PATTERN =
  /^(?:performance vertex max|xoc(?:\s*\/\s*extreme overclocking)?)$/i;

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
    titlePattern: TOP_PACKAGE_PATTERN,
    compareAtPrice: "$149.95",
    price: "$99.95",
    sourcePriceAliases: ["$179.95"],
  },
];

const stripUpgradeSuffix = (value = "") =>
  String(value || "")
    .replace(/\s*\(upgrade\)\s*$/i, "")
    .trim();

const normalizePackageTitleForMatch = (value = "") => {
  const normalized = stripUpgradeSuffix(value).toLowerCase();
  return TOP_PACKAGE_PATTERN.test(stripUpgradeSuffix(value))
    ? TOP_PACKAGE_PUBLIC_TITLE.toLowerCase()
    : normalized;
};

const isTopPackageTitle = (title = "") =>
  TOP_PACKAGE_PATTERN.test(stripUpgradeSuffix(title));

const getPublicPackageTitle = (title = "") =>
  isTopPackageTitle(title) ? TOP_PACKAGE_PUBLIC_TITLE : String(title || "");

const uniqueValues = (values = []) =>
  Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );

const getPackageTitleAliases = (title = "") =>
  isTopPackageTitle(title)
    ? uniqueValues([stripUpgradeSuffix(title), ...TOP_PACKAGE_TITLE_ALIASES])
    : uniqueValues([stripUpgradeSuffix(title)]);

const toMoney = (value) => {
  const normalized =
    typeof value === "string"
      ? value.trim().replace(/,/g, "").replace(/[$€£₹]/g, "").trim()
      : value;
  if (
    typeof normalized === "string" &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)
  ) {
    return 0;
  }
  const parsed = Number(normalized);
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
    sameMoney(sourcePrice, override.price) ||
    (Array.isArray(override.sourcePriceAliases) &&
      override.sourcePriceAliases.some((alias) => sameMoney(sourcePrice, alias)))
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
    title: getPublicPackageTitle(pkg.title),
    sourceTitle: pkg.sourceTitle || pkg.title,
    price: pricing.price,
    originalPrice: pricing.compareAtPrice,
    compareAtPrice: pricing.compareAtPrice,
  };
};

const applyPackagesPricing = (packages) =>
  Array.isArray(packages) ? packages.map(applyPackagePricing) : packages;

const api = {
  PRICE_OVERRIDES,
  TOP_PACKAGE_LEGACY_TITLE,
  TOP_PACKAGE_PUBLIC_TITLE,
  getPackageTitleAliases,
  getPublicPackageTitle,
  isTopPackageTitle,
  normalizePackageTitleForMatch,
  applyPackagePricing,
  applyPackagesPricing,
  getPackagePricePresentation,
  toMoney,
};

module.exports = api;
module.exports.default = api;
