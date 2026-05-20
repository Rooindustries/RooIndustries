const marketConfig = require("./market.js");

const INDIA_BOOKING_STATUSES = Object.freeze({
  open: "open",
  comingSoon: "coming-soon",
});

const INDIA_BOOKING_STATUS_ENV_KEYS = Object.freeze([
  "NEXT_PUBLIC_INDIA_BOOKING_STATUS",
  "INDIA_BOOKING_STATUS",
  "REACT_APP_INDIA_BOOKING_STATUS",
]);

const INDIA_BOOKING_COMING_SOON_COPY = Object.freeze({
  title: "Bookings opening soon",
  body:
    "Roo Industries India is live, but bookings and payments are temporarily paused while the India checkout flow is finalized.",
  button: "Coming Soon",
  badge: "Payments paused",
});

const getDefaultEnv = () =>
  typeof process !== "undefined" && process.env ? process.env : {};

const normalizeIndiaBookingStatus = (value = "") => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";

  if (["open", "live", "enabled", "active"].includes(normalized)) {
    return INDIA_BOOKING_STATUSES.open;
  }

  if (
    [
      "coming-soon",
      "coming_soon",
      "soon",
      "closed",
      "disabled",
      "paused",
      "maintenance",
    ].includes(normalized)
  ) {
    return INDIA_BOOKING_STATUSES.comingSoon;
  }

  return "";
};

const readBundledEnvValue = (key) => {
  if (typeof process === "undefined" || !process.env) return "";

  switch (key) {
    case "NEXT_PUBLIC_INDIA_BOOKING_STATUS":
      return process.env.NEXT_PUBLIC_INDIA_BOOKING_STATUS || "";
    case "REACT_APP_INDIA_BOOKING_STATUS":
      return process.env.REACT_APP_INDIA_BOOKING_STATUS || "";
    default:
      return "";
  }
};

const readFirstEnv = (env, keys = []) => {
  const source = env || getDefaultEnv();
  for (const key of keys) {
    const value = String(source?.[key] || readBundledEnvValue(key) || "").trim();
    if (value) return value;
  }
  return "";
};

const resolveIndiaBookingStatus = ({
  market = null,
  hostname = "",
  env = getDefaultEnv(),
} = {}) => {
  const resolvedMarket =
    market ||
    marketConfig.resolveMarket({
      hostname,
      env,
    });

  if (resolvedMarket?.id !== marketConfig.MARKET_IDS.india) {
    return INDIA_BOOKING_STATUSES.open;
  }

  return (
    normalizeIndiaBookingStatus(
      readFirstEnv(env, INDIA_BOOKING_STATUS_ENV_KEYS)
    ) || INDIA_BOOKING_STATUSES.comingSoon
  );
};

const getIndiaBookingGate = (options = {}) => {
  const status = resolveIndiaBookingStatus(options);
  return {
    status,
    isOpen: status === INDIA_BOOKING_STATUSES.open,
    isComingSoon: status !== INDIA_BOOKING_STATUSES.open,
    copy: INDIA_BOOKING_COMING_SOON_COPY,
  };
};

const getCurrentIndiaBookingGate = () => {
  const hostname =
    typeof window !== "undefined" ? window.location.hostname : "";
  const market = marketConfig.resolveMarket({ hostname });
  return getIndiaBookingGate({ market });
};

const isIndiaBookingComingSoon = (options = {}) =>
  getIndiaBookingGate(options).isComingSoon;

module.exports = {
  INDIA_BOOKING_COMING_SOON_COPY,
  INDIA_BOOKING_STATUSES,
  getCurrentIndiaBookingGate,
  getIndiaBookingGate,
  isIndiaBookingComingSoon,
  normalizeIndiaBookingStatus,
  resolveIndiaBookingStatus,
};
