import React from "react";
import { render, cleanup, waitFor } from "@testing-library/react";

const mockSanitizeBrowserSearch = jest.fn();
const mockNavigate = jest.fn();
const mockLocation = {
  pathname: "/referrals/reset",
  search: "?token=abc123",
  hash: "",
  state: null,
};

jest.mock("../components/Navbar", () => () => null);
jest.mock("../components/ReservationBanner", () => () => null);
jest.mock("../components/TawkTo", () => () => null);
jest.mock("../components/PerformanceModeNotice", () => () => null);
jest.mock("../components/PerfDebugOverlay", () => () => null);
jest.mock("../components/BookingModal", () => () => null);
jest.mock("../legacyPages/Home", () => () => null);
jest.mock("../legacyPages/Reviews", () => () => null);
jest.mock("../legacyPages/Tools", () => () => null);
jest.mock("../legacyPages/Benchmarks", () => () => null);
jest.mock("../legacyPages/Terms", () => () => null);
jest.mock("../legacyPages/PrivacyPolicy", () => () => null);
jest.mock("../legacyPages/Packages", () => () => null);
jest.mock("../legacyPages/Contact", () => () => null);
jest.mock("../legacyPages/Book", () => () => null);
jest.mock("../legacyPages/Faq", () => () => null);
jest.mock("../legacyPages/Payment", () => () => null);
jest.mock("../legacyPages/PaymentSuccess", () => () => null);
jest.mock("../legacyPages/Thankyou", () => () => null);
jest.mock("../legacyPages/UpgradeXoc", () => () => null);
jest.mock("../legacyPages/Upgrade", () => () => null);
jest.mock("../legacyPages/RefLogin", () => () => null);
jest.mock("../legacyPages/RefDashboard", () => () => null);
jest.mock("../legacyPages/RefChangePassword", () => () => null);
jest.mock("../legacyPages/RefForgot", () => () => null);
jest.mock("../legacyPages/RefReset", () => () => null);
jest.mock("../legacyPages/RefRegister", () => () => null);
jest.mock("../legacyPages/MeetTheTeam", () => () => null);
jest.mock("../legacyPages/NotFound", () => () => null);
jest.mock("../lib/homeSectionData", () => ({
  prefetchHomeSectionData: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../lib/sectionNavigation", () => ({
  consumeRouteTransitionIntent: jest.fn(() => null),
  isHomeSectionHash: jest.fn(() => false),
  normalizeSectionHash: jest.fn((value) => value || ""),
}));
jest.mock("../lib/browserSearch", () => ({
  sanitizeBrowserSearch: (...args) => mockSanitizeBrowserSearch(...args),
}));
jest.mock("@vercel/analytics/react", () => ({
  Analytics: () => null,
}), { virtual: true });
jest.mock("@vercel/speed-insights/react", () => ({
  SpeedInsights: () => null,
}), { virtual: true });
jest.mock("react-router-dom", () => ({
  BrowserRouter: ({ children }) => children,
  Routes: ({ children }) => children,
  Route: () => null,
  Navigate: () => null,
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
}), { virtual: true });

const { AppContent } = require("../App.jsx");

describe("AppContent search sync", () => {
  let replaceStateSpy;

  beforeEach(() => {
    mockSanitizeBrowserSearch.mockReset();
    mockSanitizeBrowserSearch.mockReturnValue("?token=abc123");
    mockNavigate.mockReset();
    window.scrollTo = jest.fn();
    window.history.replaceState({}, "", "/referrals/reset?token=abc123");
    replaceStateSpy = jest.spyOn(window.history, "replaceState");
    replaceStateSpy.mockClear();
  });

  afterEach(() => {
    replaceStateSpy.mockRestore();
    cleanup();
  });

  test("keeps reset tokens on non-home routes instead of stripping them", async () => {
    render(<AppContent initialHomeData={null} routeShell="memory" />);

    await waitFor(() => {
      expect(mockSanitizeBrowserSearch).toHaveBeenCalledWith(
        "/referrals/reset",
        "?token=abc123"
      );
    });

    expect(window.location.pathname).toBe("/referrals/reset");
    expect(window.location.search).toBe("?token=abc123");
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });
});
