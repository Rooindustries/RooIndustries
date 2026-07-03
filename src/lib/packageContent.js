const packagePricing = require("./packagePricing");

const WINDOWS_REOPTIMIZATION_LABEL = "Windows reoptimization every 6 months";
const { isTopPackageTitle } = packagePricing;

const ESSENTIALS_TITLE_PATTERN = /^vertex essentials$/i;
const OVERHAUL_TITLE_PATTERN = /^performance vertex overhaul$/i;

const BASE_CHECKED_BULLETS = [
  "Windows system tuning",
  "Hidden BIOS tuning",
  "Game settings tuning",
];

const OVERHAUL_EXTRA_BULLETS = [
  "CPU GPU RAM tuning",
  "Fan curve tuning",
  "Driver latency tuning",
];
const MAX_ONLY_BULLETS = [
  "Extensive hardware tuning",
  "SQM router setup",
  "6-month Windows reoptimization",
];

const PACKAGE_CONTENT_OVERRIDES = [
  {
    matches: (title) => ESSENTIALS_TITLE_PATTERN.test(title),
    checkedBullets: [...BASE_CHECKED_BULLETS],
    uncheckedBullets: [...OVERHAUL_EXTRA_BULLETS, ...MAX_ONLY_BULLETS],
  },
  {
    matches: (title) => OVERHAUL_TITLE_PATTERN.test(title),
    checkedBullets: [...BASE_CHECKED_BULLETS, ...OVERHAUL_EXTRA_BULLETS],
    uncheckedBullets: [...MAX_ONLY_BULLETS],
  },
  {
    matches: (title) => isTopPackageTitle(title),
    checkedBullets: [
      ...BASE_CHECKED_BULLETS,
      ...OVERHAUL_EXTRA_BULLETS,
      ...MAX_ONLY_BULLETS,
    ],
    uncheckedBullets: [],
    features: [
      "Everything in Performance Vertex Overhaul",
      "Maximum CPU, GPU, and RAM tuning for the best stable performance",
      "Compatible SQM router configuration",
      "Flexible session timing for working clients",
      "Choice between raw performance and part-lifespan-focused tuning",
      `${WINDOWS_REOPTIMIZATION_LABEL} for Windows-side settings and cleanup`,
      "Learn what changed so you can solve smaller issues on your own",
      "Lifetime warranty with a 24-hour response target",
    ],
  },
];

const normalizePackageText = (value = "") => {
  const text = String(value || "").trim();
  if (!text) return "";

  if (/^free re[-\s]?optimization$/i.test(text)) {
    return WINDOWS_REOPTIMIZATION_LABEL;
  }

  if (/^book\s+xoc$/i.test(text)) {
    return "Book Now";
  }

  if (
    /future upgrade path/i.test(text) &&
    /free re[-\s]?optimizations?/i.test(text)
  ) {
    return `${WINDOWS_REOPTIMIZATION_LABEL} for Windows-side settings and cleanup`;
  }

  return text
    .replace(/\bfree re[-\s]?optimizations?\b/gi, WINDOWS_REOPTIMIZATION_LABEL)
    .replace(/\breXOC(?:'d|ed)?\b/gi, "reoptimized")
    .replace(/\bXOC \/ Extreme Overclocking\b/g, "Performance Vertex Max")
    .replace(/\bXOC\b/g, "Performance Vertex Max");
};

const normalizeStringList = (items = []) =>
  Array.isArray(items)
    ? items
        .map((item) =>
          typeof item === "string" ? normalizePackageText(item) : item
        )
        .filter(Boolean)
    : items;

const findPackageContentOverride = (pkg = {}) => {
  const title = String(pkg.title || pkg.sourceTitle || "").trim();
  return (
    PACKAGE_CONTENT_OVERRIDES.find((override) => override.matches(title)) || null
  );
};

const applyPackageContentOverrides = (pkg) => {
  if (!pkg || typeof pkg !== "object") return pkg;
  const override = findPackageContentOverride(pkg);

  const normalized = {
    ...pkg,
    tag: normalizePackageText(pkg.tag),
    description: normalizePackageText(pkg.description),
    buttonText: normalizePackageText(pkg.buttonText),
    detailsButtonText: normalizePackageText(pkg.detailsButtonText),
    checkedBullets: normalizeStringList(pkg.checkedBullets),
    uncheckedBullets: normalizeStringList(pkg.uncheckedBullets),
    features: normalizeStringList(pkg.features),
  };

  if (!override) return normalized;

  return {
    ...normalized,
    checkedBullets: override.checkedBullets
      ? normalizeStringList(override.checkedBullets)
      : normalized.checkedBullets,
    uncheckedBullets: override.uncheckedBullets
      ? normalizeStringList(override.uncheckedBullets)
      : normalized.uncheckedBullets,
    features: override.features
      ? normalizeStringList(override.features)
      : normalized.features,
  };
};

const applyPackagesContentOverrides = (packages) =>
  Array.isArray(packages) ? packages.map(applyPackageContentOverrides) : packages;

const normalizeFaqQuestion = (item = {}) => {
  if (!item || typeof item !== "object") return item;
  const question = String(item.question || "");
  const answer = String(item.answer || "");

  if (
    /free re[-\s]?optimization/i.test(question) ||
    (/re[-\s]?xoc|rexoc/i.test(question) && /free/i.test(question)) ||
    /upgrade pc each 6 months/i.test(question)
  ) {
    return {
      ...item,
      question: "What does Windows reoptimization every 6 months mean?",
      answer:
        "For Performance Vertex Max, I can redo the Windows-side optimization once every 6 months. This is not a full free retune for new hardware or an entire PC rebuild.",
    };
  }

  if (/change a part before the 6[-\s]?month period/i.test(question)) {
    return {
      ...item,
      question: "What if I change a part before the 6-month period?",
      answer:
        "If you need help before the 6-month window, message me first. Hardware changes and full retunes are handled case by case as paid support sessions.",
    };
  }

  return {
    ...item,
    question: normalizePackageText(question),
    answer: normalizePackageText(answer)
      .replace(
        /while Performance Vertex Max has a lifetime warranty/i,
        "while Performance Vertex Max keeps the lifetime warranty"
      )
      .replace(
        /Performance Vertex Max has a lifetime warranty/i,
        "Performance Vertex Max keeps the lifetime warranty"
      ),
  };
};

const normalizeFaqQuestions = (items = []) =>
  Array.isArray(items) ? items.map(normalizeFaqQuestion) : items;

const api = {
  WINDOWS_REOPTIMIZATION_LABEL,
  PACKAGE_CONTENT_OVERRIDES,
  applyPackageContentOverrides,
  applyPackagesContentOverrides,
  normalizeFaqQuestion,
  normalizeFaqQuestions,
  normalizePackageText,
};

module.exports = api;
module.exports.default = api;
