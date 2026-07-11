import React from "react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToPipeableStream } from "react-dom/server";
import { waitFor } from "@testing-library/react";
import { PassThrough } from "node:stream";
import {
  clearImmediate as nodeClearImmediate,
  setImmediate as nodeSetImmediate,
} from "node:timers";

const mockLocation = {
  pathname: "/payment",
  search: "",
  hash: "",
  state: null,
};

const mockNavigate = jest.fn();
const marker = (name) => () => <div>{name}</div>;
const originalSetImmediate = global.setImmediate;
const originalClearImmediate = global.clearImmediate;

jest.mock("../components/Navbar", () => () => null);
jest.mock("../components/ReservationBanner", () => () => null);
jest.mock("../components/IntercomMessenger", () => () => null);
jest.mock("../components/PerfDebugOverlay", () => () => null);
jest.mock("../components/BookingModal", () => ({ children }) => (
  <div role="dialog">{children}</div>
));
jest.mock("../legacyPages/Home", () => marker("HOME BACKGROUND"));
jest.mock("../legacyPages/Reviews", () => marker("REVIEWS BACKGROUND"));
jest.mock("../legacyPages/Tools", () => () => null);
jest.mock("../legacyPages/Benchmarks", () => () => null);
jest.mock("../legacyPages/Terms", () => () => null);
jest.mock("../legacyPages/PrivacyPolicy", () => () => null);
jest.mock("../legacyPages/Packages", () => () => null);
jest.mock("../legacyPages/Contact", () => () => null);
jest.mock("../legacyPages/Book", () => () => null);
jest.mock("../legacyPages/Faq", () => () => null);
jest.mock("../legacyPages/Payment", () => marker("PAYMENT MODAL"));
jest.mock("../legacyPages/PaymentSuccess", () => () => null);
jest.mock("../legacyPages/Thankyou", () => () => null);
jest.mock("../legacyPages/UpgradeXoc", () => () => null);
jest.mock("../legacyPages/Upgrade", () => () => null);
jest.mock("../legacyPages/Download", () => () => null);
jest.mock("../legacyPages/RefLogin", () => () => null);
jest.mock("../legacyPages/RefDashboard", () => () => null);
jest.mock("../legacyPages/RefChangePassword", () => () => null);
jest.mock("../legacyPages/RefForgot", () => () => null);
jest.mock("../legacyPages/RefReset", () => () => null);
jest.mock("../legacyPages/RefRegister", () => () => null);
jest.mock("../legacyPages/MeetTheTeam", () => () => null);
jest.mock("../legacyPages/NotFound", () => () => null);
jest.mock("../lib/performanceProfile", () => ({
  initializePerformanceProfile: jest.fn(),
}));
jest.mock("../lib/homeSectionData", () => ({
  prefetchHomeSectionData: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../lib/sectionNavigation", () => ({
  consumeRouteTransitionIntent: jest.fn(() => null),
  isHomeSectionHash: jest.fn(() => false),
  normalizeSectionHash: jest.fn((value) => value || ""),
}));
jest.mock("../lib/browserSearch", () => ({
  sanitizeBrowserSearch: jest.fn((_, search) => search || ""),
}));
jest.mock("@vercel/analytics/react", () => ({ Analytics: () => null }), {
  virtual: true,
});
jest.mock("@vercel/speed-insights/react", () => ({ SpeedInsights: () => null }), {
  virtual: true,
});
jest.mock(
  "react-router-dom",
  () => ({
    BrowserRouter: ({ children }) => children,
    Routes: ({ children, location }) => {
      const pathname = location?.pathname || mockLocation.pathname;
      const routes = React.Children.toArray(children);
      const route = routes.find((candidate) => candidate.props.path === pathname);
      return route?.props.element || null;
    },
    Route: () => null,
    Navigate: () => null,
    useLocation: () => mockLocation,
    useNavigate: () => mockNavigate,
  }),
  { virtual: true }
);

const { AppContent } = require("../App.jsx");

const renderAppToString = (tree) =>
  new Promise((resolve, reject) => {
    let markup = "";
    const output = new PassThrough();
    output.setEncoding("utf8");
    output.on("data", (chunk) => {
      markup += chunk;
    });
    output.on("end", () => resolve(markup));
    output.on("error", reject);

    const stream = renderToPipeableStream(tree, {
      onAllReady() {
        stream.pipe(output);
      },
      onError: reject,
    });
  });

describe("checkout background hydration", () => {
  beforeAll(() => {
    global.setImmediate = nodeSetImmediate;
    global.clearImmediate = nodeClearImmediate;
  });

  afterAll(() => {
    global.setImmediate = originalSetImmediate;
    global.clearImmediate = originalClearImmediate;
  });

  beforeEach(() => {
    window.sessionStorage.clear();
    window.scrollTo = jest.fn();
  });

  test("restores the stored background only after the first client render", async () => {
    const tree = <AppContent initialHomeData={null} routeShell="memory" />;
    const markup = await renderAppToString(tree);
    window.sessionStorage.setItem(
      "flow_background_location",
      JSON.stringify({ pathname: "/reviews", search: "", hash: "" })
    );

    const container = document.createElement("div");
    container.innerHTML = markup;
    document.body.appendChild(container);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let root;

    await act(async () => {
      root = hydrateRoot(container, tree);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container).toHaveTextContent("REVIEWS BACKGROUND");
    });
    expect(container).toHaveTextContent("PAYMENT MODAL");
    const hydrationErrors = errorSpy.mock.calls.filter((args) =>
      args.some((value) =>
        /hydration failed|did not match|minified react error #418/i.test(
          String(value)
        )
      )
    );
    expect(hydrationErrors).toEqual([]);

    await act(async () => root.unmount());
    errorSpy.mockRestore();
    container.remove();
  });
});
