const { cleanup, render } = require("@testing-library/react");

const loadRouteRenderer = async () => {
  jest.resetModules();

  const LegacyRoutePage = jest.fn(() => null);
  const SeoFallback = jest.fn(() => null);
  const fetchHomePageData = jest.fn().mockResolvedValue({ packagesList: [] });

  jest.doMock("../next/LegacyRoutePage.jsx", () => ({
    __esModule: true,
    default: LegacyRoutePage,
  }));
  jest.doMock("../next/SeoFallback.jsx", () => ({
    __esModule: true,
    default: SeoFallback,
  }));
  jest.doMock("../lib/sanityServer.js", () => ({
    __esModule: true,
    default: {
      fetchHomePageData,
    },
  }));

  const RouteRenderer = require("../next/RouteRenderer.jsx").default;

  return {
    RouteRenderer,
    LegacyRoutePage,
    fetchHomePageData,
  };
};

describe("RouteRenderer", () => {
  afterEach(() => {
    cleanup();
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("resolves promise search params before rendering the legacy route page", async () => {
    const { RouteRenderer, LegacyRoutePage, fetchHomePageData } =
      await loadRouteRenderer();
    const initialHomeData = { faqQuestions: [] };

    const tree = await RouteRenderer({
      pathname: "/",
      searchParams: Promise.resolve({
        ref: "creator123",
        utm_source: "discord",
      }),
      initialHomeData,
    });

    render(tree);

    expect(fetchHomePageData).not.toHaveBeenCalled();
    expect(LegacyRoutePage).toHaveBeenCalledTimes(1);
    expect(LegacyRoutePage.mock.calls[0][0]).toMatchObject({
      pathname: "/",
      searchParams: {
        ref: "creator123",
        utm_source: "discord",
      },
      initialHomeData,
    });
  });
});
