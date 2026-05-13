const {
  normalizeSiteSettings,
  shouldShowMaintenancePage,
} = require("../lib/siteMode.js");

describe("site maintenance mode", () => {
  test("defaults to live when Sanity settings are missing", () => {
    expect(normalizeSiteSettings()).toMatchObject({ siteMode: "live" });
  });

  test("normalizes maintenance copy with defaults", () => {
    expect(normalizeSiteSettings({ siteMode: "maintenance" })).toMatchObject({
      siteMode: "maintenance",
    });
  });

  test("only India market is allowed to show the maintenance page", () => {
    const settings = { siteMode: "maintenance" };

    expect(
      shouldShowMaintenancePage({ market: { id: "india" }, settings })
    ).toBe(true);
    expect(
      shouldShowMaintenancePage({ market: { id: "global" }, settings })
    ).toBe(false);
  });
});
