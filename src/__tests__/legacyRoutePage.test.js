const React = require("react");
const { cleanup, render } = require("@testing-library/react");

const loadLegacyRoutePage = () => {
  jest.resetModules();

  const MemoryRouter = jest.fn(({ children }) => children);
  const AppContent = jest.fn(() => null);

  jest.doMock("react-router-dom", () => ({
    __esModule: true,
    MemoryRouter,
  }), { virtual: true });
  jest.doMock("../App.jsx", () => ({
    __esModule: true,
    AppContent,
  }));

  return {
    LegacyRoutePage: require("../next/LegacyRoutePage.jsx").default,
    buildQueryString: require("../next/routeQuery.js").buildQueryString,
    MemoryRouter,
    AppContent,
  };
};

describe("LegacyRoutePage", () => {
  afterEach(() => {
    cleanup();
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("preserves query params from URLSearchParams when building the initial memory route", () => {
    const { buildQueryString } = loadLegacyRoutePage();

    expect(
      buildQueryString(new URLSearchParams([["token", "abc123"]]))
    ).toBe("?token=abc123");
  });

  test("passes the reset token through to the initial memory router entry", () => {
    const { LegacyRoutePage, MemoryRouter, AppContent } = loadLegacyRoutePage();

    render(
      React.createElement(LegacyRoutePage, {
        pathname: "/referrals/reset",
        searchParams: new URLSearchParams([["token", "abc123"]]),
      })
    );

    expect(MemoryRouter).toHaveBeenCalledTimes(1);
    expect(MemoryRouter.mock.calls[0][0]).toMatchObject({
      initialEntries: ["/referrals/reset?token=abc123"],
    });
    expect(AppContent).toHaveBeenCalledWith(
      expect.objectContaining({
        routeShell: "memory",
      }),
      undefined
    );
  });
});
