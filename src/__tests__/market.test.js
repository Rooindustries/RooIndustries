const loadMarket = () => {
  jest.resetModules();
  return require("../lib/market.js");
};

describe("market resolver", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SITE_MARKET;
    delete process.env.NEXT_PUBLIC_SITE_MARKET;
    delete process.env.SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.SANITY_DATASET;
    delete process.env.SANITY_PRIVATE_DATASET;
    delete process.env.NEXT_PUBLIC_SANITY_DATASET;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test("resolves global by default", () => {
    const { resolveMarket } = loadMarket();
    expect(resolveMarket({ hostname: "www.rooindustries.com" })).toMatchObject({
      id: "global",
      currency: "USD",
      paypalEnabled: true,
    });
  });

  test("resolves India from .in hostname", () => {
    const { resolveMarket } = loadMarket();
    expect(resolveMarket({ hostname: "www.rooindustries.in" })).toMatchObject({
      id: "india",
      currency: "INR",
      paypalEnabled: false,
      razorpayEnabled: false,
    });
  });

  test("explicit env market wins for preview hosts", () => {
    process.env.SITE_MARKET = "india";
    const { resolveMarket } = loadMarket();
    expect(resolveMarket({ hostname: "preview.vercel.app" }).id).toBe("india");
  });

  test("India market defaults to production-in Sanity dataset", () => {
    process.env.SITE_MARKET = "india";
    const { resolveMarketSanityDataset } = loadMarket();
    expect(resolveMarketSanityDataset()).toBe("production-in");
  });

  test("explicit Sanity dataset overrides market default", () => {
    process.env.SITE_MARKET = "india";
    process.env.SANITY_DATASET = "custom";
    const { resolveMarketSanityDataset } = loadMarket();
    expect(resolveMarketSanityDataset()).toBe("custom");
  });
});
