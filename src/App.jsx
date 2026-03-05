import React, { useState, useEffect, Suspense, lazy } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  useLocation,
  useNavigate,
  Navigate,
} from "react-router-dom";
import Navbar from "./components/Navbar";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import ReservationBanner from "./components/ReservationBanner";
import TawkTo from "./components/TawkTo";
import PerformanceModeNotice from "./components/PerformanceModeNotice";
import Hero from "./components/Hero";

const Home = lazy(() => import("./legacyPages/Home"));
import Reviews from "./legacyPages/Reviews";
import Tools from "./legacyPages/Tools";
const Benchmarks = lazy(() => import("./legacyPages/Benchmarks"));
const Terms = lazy(() => import("./legacyPages/Terms"));
const Privacy = lazy(() => import("./legacyPages/PrivacyPolicy"));
const Packages = lazy(() => import("./legacyPages/Packages"));
const Faq = lazy(() => import("./legacyPages/Faq"));
const Contact = lazy(() => import("./legacyPages/Contact"));
const Book = lazy(() => import("./legacyPages/Book"));
const Payment = lazy(() => import("./legacyPages/Payment"));
const PaymentSuccess = lazy(() => import("./legacyPages/PaymentSuccess"));
const Thankyou = lazy(() => import("./legacyPages/Thankyou"));
const UpgradeXoc = lazy(() => import("./legacyPages/UpgradeXoc"));
const Upgrade = lazy(() => import("./legacyPages/Upgrade"));
const BookingModal = lazy(() => import("./components/BookingModal"));

const RefLogin = lazy(() => import("./legacyPages/RefLogin"));
const RefDashboard = lazy(() => import("./legacyPages/RefDashboard"));
const RefChangePassword = lazy(() => import("./legacyPages/RefChangePassword"));
const RefForgot = lazy(() => import("./legacyPages/RefForgot"));
const RefReset = lazy(() => import("./legacyPages/RefReset"));
const RefRegister = lazy(() => import("./legacyPages/RefRegister"));
const MeetTheTeam = lazy(() => import("./legacyPages/MeetTheTeam"));
const NotFound = lazy(() => import("./legacyPages/NotFound"));

const DeferredTelemetry = () => {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(() => setEnabled(true), {
        timeout: 2500,
      });
      return () => window.cancelIdleCallback?.(idleId);
    }

    const timeoutId = window.setTimeout(() => setEnabled(true), 1500);
    return () => window.clearTimeout(timeoutId);
  }, []);

  if (!enabled) return null;

  return (
    <>
      <Analytics />
      <SpeedInsights />
    </>
  );
};

const RouteFallback = () => (
  <div className="pt-16 text-center text-slate-300 text-sm">Loading...</div>
);

const HomeRouteFallback = () => (
  <>
    <Hero />
    <div className="min-h-[900px]" aria-hidden="true" />
  </>
);

const withRouteSuspense = (node, fallback = <RouteFallback />) => (
  <Suspense fallback={fallback}>{node}</Suspense>
);

function RedirectToDiscord() {
  React.useEffect(() => {
    window.location.href = "https://discord.gg/M7nTkn9dxE";
  }, []);
  return null;
}

function AnimatedRoutes({ setIsModalOpen, routesLocation, routeKey }) {
  const baseLocation = useLocation();
  const location = routesLocation || baseLocation;
  const motionKey = routeKey || `${location.pathname}${location.search || ""}`;

  return (
    <div key={motionKey} className="w-full flex flex-col flex-1">
        <Routes location={location}>
          <Route
            path="/"
            element={withRouteSuspense(<Home />, <HomeRouteFallback />)}
          />
          <Route path="/packages" element={withRouteSuspense(<Packages />)} />
          <Route
            path="/benchmarks"
            element={withRouteSuspense(
              <Benchmarks setIsModalOpen={setIsModalOpen} />
            )}
          />
          <Route path="/privacy" element={withRouteSuspense(<Privacy />)} />
          <Route path="/terms" element={withRouteSuspense(<Terms />)} />
          <Route
            path="/reviews"
            element={<Reviews setIsModalOpen={setIsModalOpen} />}
          />
          <Route path="/booking" element={withRouteSuspense(<Book />)} />
          <Route path="/contact" element={withRouteSuspense(<Contact />)} />
          <Route path="/faq" element={withRouteSuspense(<Faq />)} />
          <Route path="/discord" element={<RedirectToDiscord />} />
          <Route path="/payment" element={withRouteSuspense(<Payment />)} />
          <Route
            path="/payment-success"
            element={withRouteSuspense(<PaymentSuccess />)}
          />
          <Route path="/thank-you" element={withRouteSuspense(<Thankyou />)} />
          <Route path="/tools" element={<Tools />} />
          <Route
            path="/meet-the-team"
            element={withRouteSuspense(<MeetTheTeam />)}
          />
          <Route
            path="/upgrade/:slug"
            element={withRouteSuspense(<Upgrade />)}
          />
          <Route
            path="/upgrade-xoc"
            element={withRouteSuspense(<UpgradeXoc />)}
          />

          {/* Referral system routes */}
          <Route
            path="/referrals/login"
            element={withRouteSuspense(<RefLogin />)}
          />
          <Route
            path="/referrals/dashboard"
            element={withRouteSuspense(<RefDashboard />)}
          />
          <Route
            path="/referrals/change-password"
            element={withRouteSuspense(<RefChangePassword />)}
          />
          <Route
            path="/referrals/forgot"
            element={withRouteSuspense(<RefForgot />)}
          />
          <Route
            path="/referrals/reset"
            element={withRouteSuspense(<RefReset />)}
          />
          <Route
            path="/referrals/register"
            element={withRouteSuspense(<RefRegister />)}
          />
          <Route
            path="/referrals/Register"
            element={<Navigate to="/referrals/register" replace />}
          />
          <Route path="*" element={withRouteSuspense(<NotFound />)} />
        </Routes>
    </div>
  );
}

export function AppContent() {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();
  const pathName = location.pathname || "";
  const FLOW_BACKGROUND_KEY = "flow_background_location";

  const readStoredBackground = () => {
    try {
      const raw = sessionStorage.getItem(FLOW_BACKGROUND_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.pathname) {
        return parsed;
      }
    } catch {}
    return null;
  };

  const writeStoredBackground = (loc) => {
    try {
      if (!loc || !loc.pathname) return;
      sessionStorage.setItem(
        FLOW_BACKGROUND_KEY,
        JSON.stringify({
          pathname: loc.pathname,
          search: loc.search || "",
          hash: loc.hash || "",
        })
      );
    } catch {}
  };

  const isBookingRoute = pathName.startsWith("/booking");
  const isPaymentRoute = pathName === "/payment";
  const isPaymentSuccessRoute = pathName.startsWith("/payment-success");
  const isThankYouRoute = pathName.startsWith("/thank-you");
  const isFlowRoute =
    isBookingRoute ||
    isPaymentRoute ||
    isPaymentSuccessRoute ||
    isThankYouRoute;

  useEffect(() => {
    const stateBackground = location.state?.backgroundLocation;
    if (stateBackground?.pathname) {
      writeStoredBackground(stateBackground);
      return;
    }
    if (!isFlowRoute) {
      writeStoredBackground({
        pathname: location.pathname,
        search: location.search || "",
        hash: location.hash || "",
      });
    }
  }, [location.pathname, location.search, location.hash, location.state, isFlowRoute]);

  const storedBackground = readStoredBackground();
  const backgroundLocation =
    location.state && location.state.backgroundLocation
      ? location.state.backgroundLocation
      : isFlowRoute
      ? storedBackground
      : null;
  const fallbackLocation =
    isFlowRoute && !backgroundLocation
      ? { ...location, pathname: "/", search: "", hash: "" }
      : null;
  const routesLocation = backgroundLocation || fallbackLocation || location;
  const routesKey = `${routesLocation.pathname}${routesLocation.search || ""}`;

  const closeBookingModal = () => {
    const target = backgroundLocation || {
      pathname: "/",
      search: "",
      hash: "",
      state: null,
    };
    const targetPath = `${target.pathname || "/"}${target.search || ""}${
      target.hash || ""
    }`;
    navigate(targetPath, {
      replace: isFlowRoute,
      state: target.state,
    });
  };

  return (
    <>
      <DeferredTelemetry />

      <div
        className="relative min-h-screen flex flex-col text-white overflow-hidden 
        bg-[linear-gradient(to_top,#00b7c0_0%,#006185_30%,#001f5a_65%,#000040_100%)]
        bg-scroll md:bg-fixed"
      >
        {/* Background layers */}
        <div
          className="absolute inset-0 bg-[linear-gradient(45deg,rgba(255,255,255,0.05)_1px,transparent_1px)] 
                      bg-[size:40px_40px] opacity-50"
        ></div>
        <div
          className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.25),rgba(3,7,18,1) 80%)] 
                      "
        ></div>

        {/* Navbar and pages */}
        <main
          className="relative z-10 flex flex-col flex-1"
          style={{ paddingTop: "var(--header-offset)" }}
        >
          <Navbar />
          <ReservationBanner />

          <AnimatedRoutes
            setIsModalOpen={setIsModalOpen}
            routesLocation={routesLocation}
            routeKey={routesKey}
          />
        </main>
      </div>
      {isFlowRoute && (
        <Suspense fallback={null}>
          <BookingModal open onClose={closeBookingModal}>
            <Suspense fallback={<RouteFallback />}>
              {isPaymentSuccessRoute ? (
                <PaymentSuccess hideFooter />
              ) : isThankYouRoute ? (
                <Thankyou hideFooter />
              ) : isPaymentRoute ? (
                <Payment hideFooter />
              ) : (
                <Book hideFooter compact />
              )}
            </Suspense>
          </BookingModal>
        </Suspense>
      )}
      <PerformanceModeNotice />
    </>
  );
}

function App() {
  // Example: add routes here to disable chat without refactoring.
  const tawkDisabledRoutes = [];
  // const tawkDisabledRoutes = ["/booking"]; // Disables chat on /booking and nested routes.

  return (
    <Router>
      <TawkTo disabledRoutes={tawkDisabledRoutes} />
      <AppContent />
    </Router>
  );
}

export default App;
