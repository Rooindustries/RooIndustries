const MARKET_IDS = Object.freeze({
  global: "global",
  india: "india",
});

const MARKET_CONFIGS = Object.freeze({
  [MARKET_IDS.global]: Object.freeze({
    id: MARKET_IDS.global,
    label: "Global",
    hostnameSuffix: ".com",
    primaryHost: "www.rooindustries.com",
    siteUrl: "https://www.rooindustries.com",
    sanityDataset: "production",
    currency: "USD",
    areaServed: "Worldwide",
    paypalEnabled: true,
    razorpayEnabled: true,
  }),
  [MARKET_IDS.india]: Object.freeze({
    id: MARKET_IDS.india,
    label: "India",
    hostnameSuffix: ".in",
    primaryHost: "www.rooindustries.in",
    siteUrl: "https://www.rooindustries.in",
    sanityDataset: "production-in",
    currency: "INR",
    areaServed: "India",
    paypalEnabled: false,
    razorpayEnabled: false,
  }),
});

const normalizeHost = (value = "") =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0];

const normalizeMarketId = (value = "") => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === MARKET_IDS.india || normalized === "in") {
    return MARKET_IDS.india;
  }
  if (normalized === MARKET_IDS.global || normalized === "com") {
    return MARKET_IDS.global;
  }
  return "";
};

const resolveMarketIdFromHost = (hostname = "") => {
  const host = normalizeHost(hostname);
  if (
    host === "rooindustries.in" ||
    host === "www.rooindustries.in" ||
    host.endsWith(".rooindustries.in")
  ) {
    return MARKET_IDS.india;
  }
  return MARKET_IDS.global;
};

const readBundledEnvValue = (key) => {
  switch (key) {
    case "NEXT_PUBLIC_SITE_MARKET":
      return process.env.NEXT_PUBLIC_SITE_MARKET || "";
    case "NEXT_PUBLIC_SITE_URL":
      return process.env.NEXT_PUBLIC_SITE_URL || "";
    case "REACT_APP_SITE_URL":
      return process.env.REACT_APP_SITE_URL || "";
    case "NEXT_PUBLIC_SANITY_DATASET":
      return process.env.NEXT_PUBLIC_SANITY_DATASET || "";
    default:
      return "";
  }
};

const readFirstEnv = (env, keys = []) => {
  for (const key of keys) {
    const value = String(env?.[key] || readBundledEnvValue(key) || "").trim();
    if (value) return value;
  }
  return "";
};

const resolveMarketIdFromEnv = (env = process.env) => {
  const explicit = normalizeMarketId(
    readFirstEnv(env, ["NEXT_PUBLIC_SITE_MARKET", "SITE_MARKET"])
  );
  if (explicit) return explicit;

  const siteUrl = readFirstEnv(env, [
    "NEXT_PUBLIC_SITE_URL",
    "REACT_APP_SITE_URL",
    "SITE_URL",
  ]);
  if (siteUrl) {
    return resolveMarketIdFromHost(siteUrl);
  }

  return "";
};

const resolveMarket = ({ hostname = "", env = process.env } = {}) => {
  const envMarket = resolveMarketIdFromEnv(env);
  const marketId = envMarket || resolveMarketIdFromHost(hostname);
  return MARKET_CONFIGS[marketId] || MARKET_CONFIGS[MARKET_IDS.global];
};

const resolveCurrentMarket = () => {
  const hostname =
    typeof window !== "undefined" ? window.location.hostname : "";
  return resolveMarket({ hostname });
};

const resolveMarketCurrency = (options = {}) => resolveMarket(options).currency;

const resolveMarketSiteUrl = (options = {}) => {
  const market = resolveMarket(options);
  const envUrl = readFirstEnv(options.env || process.env, [
    "NEXT_PUBLIC_SITE_URL",
    "REACT_APP_SITE_URL",
    "SITE_URL",
  ]);
  return (envUrl || market.siteUrl).replace(/\/$/, "");
};

const resolveMarketSanityDataset = (options = {}) => {
  const env = options.env || process.env;
  const explicit = readFirstEnv(env, [
    "NEXT_PUBLIC_SANITY_DATASET",
    "SANITY_PRIVATE_DATASET",
    "SANITY_DATASET",
  ]);
  return explicit || resolveMarket(options).sanityDataset;
};

const isIndiaMarket = (options = {}) =>
  resolveMarket(options).id === MARKET_IDS.india;

module.exports = {
  MARKET_CONFIGS,
  MARKET_IDS,
  isIndiaMarket,
  normalizeHost,
  normalizeMarketId,
  resolveCurrentMarket,
  resolveMarket,
  resolveMarketCurrency,
  resolveMarketIdFromEnv,
  resolveMarketIdFromHost,
  resolveMarketSanityDataset,
  resolveMarketSiteUrl,
};
