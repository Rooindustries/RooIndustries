const normalizeSiteSettings = (settings = {}) => ({
  siteMode:
    String(settings?.siteMode || "").trim().toLowerCase() === "maintenance"
      ? "maintenance"
      : "live",
});

const isMaintenanceMode = (settings = {}) =>
  normalizeSiteSettings(settings).siteMode === "maintenance";

const shouldShowMaintenancePage = ({ market, settings } = {}) =>
  market?.id === "india" && isMaintenanceMode(settings);

module.exports = {
  isMaintenanceMode,
  normalizeSiteSettings,
  shouldShowMaintenancePage,
};
