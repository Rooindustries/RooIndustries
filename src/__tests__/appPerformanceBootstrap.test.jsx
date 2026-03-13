const mockComponent = () => () => null;
const mockNavigate = jest.fn();
const mockLocation = {
  pathname: "/booking",
  search: "",
  hash: "",
  state: null,
};

const mockLegacyPages = [
  "../legacyPages/Home",
  "../legacyPages/Reviews",
  "../legacyPages/Tools",
  "../legacyPages/Benchmarks",
  "../legacyPages/Terms",
  "../legacyPages/PrivacyPolicy",
  "../legacyPages/Packages",
  "../legacyPages/Contact",
  "../legacyPages/Book",
  "../legacyPages/Faq",
  "../legacyPages/Payment",
  "../legacyPages/PaymentSuccess",
  "../legacyPages/Thankyou",
  "../legacyPages/UpgradeXoc",
  "../legacyPages/Upgrade",
  "../legacyPages/RefLogin",
  "../legacyPages/RefDashboard",
  "../legacyPages/RefChangePassword",
  "../legacyPages/RefForgot",
  "../legacyPages/RefReset",
  "../legacyPages/RefRegister",
  "../legacyPages/MeetTheTeam",
  "../legacyPages/NotFound",
];

const loadAppContent = () => {
  jest.resetModules();
  const initializePerformanceProfile = jest.fn();

  jest.doMock("../components/Navbar", mockComponent);
  jest.doMock("../components/ReservationBanner", mockComponent);
  jest.doMock("../components/TawkTo", mockComponent);
  jest.doMock("../components/PerformanceModeNotice", mockComponent);
  jest.doMock("../components/PerfDebugOverlay", mockComponent);
  jest.doMock("../components/BookingModal", mockComponent);

  mockLegacyPages.forEach((modulePath) => {
    jest.doMock(modulePath, mockComponent);
  });

  jest.doMock("../lib/performanceProfile", () => ({
    initializePerformanceProfile,
  }));
  jest.doMock("../lib/homeSectionData", () => ({
    prefetchHomeSectionData: jest.fn().mockResolvedValue(undefined),
  }));
  jest.doMock("../lib/sectionNavigation", () => ({
    consumeRouteTransitionIntent: jest.fn(() => null),
    isHomeSectionHash: jest.fn(() => false),
    normalizeSectionHash: jest.fn((value) => value || ""),
  }));
  jest.doMock("../lib/browserSearch", () => ({
    sanitizeBrowserSearch: jest.fn((_, search) => search || ""),
  }));
  jest.doMock(
    "@vercel/analytics/react",
    () => ({
      Analytics: () => null,
    }),
    { virtual: true }
  );
  jest.doMock(
    "@vercel/speed-insights/react",
    () => ({
      SpeedInsights: () => null,
    }),
    { virtual: true }
  );
  jest.doMock(
    "react-router-dom",
    () => ({
      BrowserRouter: ({ children }) => children,
      Routes: ({ children }) => children,
      Route: () => null,
      Navigate: () => null,
      useLocation: () => mockLocation,
      useNavigate: () => mockNavigate,
    }),
    { virtual: true }
  );

  const { AppContent } = require("../App.jsx");
  return { AppContent, initializePerformanceProfile };
};

describe("App performance bootstrap", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("does not bootstrap performance mode during module import", () => {
    const { initializePerformanceProfile } = loadAppContent();

    expect(initializePerformanceProfile).not.toHaveBeenCalled();
  });
});
