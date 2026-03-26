import React, { useState, useEffect, Suspense, lazy, useRef } from "react";
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
import PerfDebugOverlay from "./components/PerfDebugOverlay";
import { initializePerformanceProfile } from "./lib/performanceProfile";
import Home from "./legacyPages/Home";
import {
  consumeRouteTransitionIntent,
  isHomeSectionHash,
  normalizeSectionHash,
} from "./lib/sectionNavigation";
import { sanitizeBrowserSearch } from "./lib/browserSearch";
import { prefetchHomeSectionData } from "./lib/homeSectionData";

import Reviews from "./legacyPages/Reviews";
import Tools from "./legacyPages/Tools";
const Benchmarks = lazy(() => import("./legacyPages/Benchmarks"));
const Terms = lazy(() => import("./legacyPages/Terms"));
const Privacy = lazy(() => import("./legacyPages/PrivacyPolicy"));
const Packages = lazy(() => import("./legacyPages/Packages"));
const Contact = lazy(() => import("./legacyPages/Contact"));
const Book = lazy(() => import("./legacyPages/Book"));
const FaqPage = lazy(() => import("./legacyPages/Faq"));
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
    const host = String(window.location.hostname || "").toLowerCase();
    const isLocalHost = host === "localhost" || host === "127.0.0.1";
    if (isLocalHost) return undefined;

    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(() => setEnabled(true), {
        timeout: 6000,
      });
      return () => window.cancelIdleCallback?.(idleId);
    }

    const timeoutId = window.setTimeout(() => setEnabled(true), 5000);
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

const DeferredTawk = ({ disabledRoutes }) => {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    let timeoutId;
    let activated = false;

    const enable = () => {
      if (activated) return;
      activated = true;
      setEnabled(true);
      events.forEach((eventName) =>
        window.removeEventListener(eventName, enable, true)
      );
    };

    const events = ["pointerdown", "keydown", "touchstart", "scroll"];
    events.forEach((eventName) =>
      window.addEventListener(eventName, enable, {
        once: true,
        passive: true,
        capture: true,
      })
    );

    timeoutId = window.setTimeout(enable, 12000);

    return () => {
      events.forEach((eventName) =>
        window.removeEventListener(eventName, enable, true)
      );
      if (typeof timeoutId === "number") {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  if (!enabled) return null;
  return <TawkTo disabledRoutes={disabledRoutes} />;
};

const RouteFallback = () => (
  <div className="pt-16 text-center text-slate-300 text-sm">Loading...</div>
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

function AnimatedRoutes({
  setIsModalOpen,
  routesLocation,
  routeKey,
  initialHomeData,
  initialRouteData,
}) {
  const baseLocation = useLocation();
  const location = routesLocation || baseLocation;
  const motionKey = routeKey || `${location.pathname}${location.search || ""}`;

  return (
    <div key={motionKey} className="w-full flex flex-col flex-1">
        <Routes location={location}>
          <Route path="/" element={<Home initialData={initialHomeData} />} />
          <Route
            path="/packages"
            element={withRouteSuspense(
              <Packages initialData={initialRouteData?.packages || null} />
            )}
          />
          <Route
            path="/benchmarks"
            element={withRouteSuspense(
              <Benchmarks
                setIsModalOpen={setIsModalOpen}
                initialData={initialRouteData?.benchmarks || null}
              />
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
          <Route
            path="/faq"
            element={withRouteSuspense(
              <FaqPage initialData={initialHomeData} />
            )}
          />
          <Route path="/discord" element={<RedirectToDiscord />} />
          <Route path="/payment" element={withRouteSuspense(<Payment />)} />
          <Route
            path="/payment-success"
            element={withRouteSuspense(<PaymentSuccess />)}
          />
          <Route path="/thank-you" element={withRouteSuspense(<Thankyou />)} />
          <Route
            path="/tools"
            element={<Tools initialData={initialRouteData?.tools || null} />}
          />
          <Route
            path="/meet-the-team"
            element={withRouteSuspense(
              <MeetTheTeam initialData={initialRouteData?.meetTheTeam || null} />
            )}
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

export function AppContent({
  initialHomeData = null,
  initialRouteData = null,
  routeShell = "browser",
}) {
  const [, setIsModalOpen] = useState(false);
  const [showRouteTransition, setShowRouteTransition] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();
  const lastRouteKeyRef = useRef("");
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
    initializePerformanceProfile();
  }, []);


  useEffect(() => {
    if (typeof window === "undefined") return;
    const intent = consumeRouteTransitionIntent();
    if (!intent) {
      document.documentElement.classList.remove("route-transition-out");
      return;
    }
    const ageMs = Date.now() - Number(intent.ts || 0);
    if (ageMs > 5000) {
      document.documentElement.classList.remove("route-transition-out");
      return;
    }

    setShowRouteTransition(true);
    const clearOutClassId = window.setTimeout(() => {
      document.documentElement.classList.remove("route-transition-out");
    }, 120);

    const finishTransition = () => {
      setShowRouteTransition(false);
    };

    const handleSettled = (event) => {
      const settledHash = normalizeSectionHash(event?.detail?.hash || "");
      const intentHash = normalizeSectionHash(intent.hash || "");
      if (!intentHash || settledHash === intentHash) {
        finishTransition();
      }
    };

    window.addEventListener("roo:section-align-settled", handleSettled);

    const hideOverlayId = window.setTimeout(() => {
      finishTransition();
    }, 1600);

    return () => {
      window.clearTimeout(clearOutClassId);
      window.clearTimeout(hideOverlayId);
      window.removeEventListener("roo:section-align-settled", handleSettled);
    };
  }, [location.pathname, location.hash]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleCancelTransition = () => {
      setShowRouteTransition(false);
      document.documentElement.classList.remove("route-transition-out");
    };
    window.addEventListener("roo:cancel-route-transition", handleCancelTransition);
    return () => {
      window.removeEventListener("roo:cancel-route-transition", handleCancelTransition);
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;

    if (!showRouteTransition) {
      document.documentElement.classList.remove("route-transition-lock");
      document.body.classList.remove("route-transition-lock");
      window.dispatchEvent(
        new CustomEvent("roo:route-transition-visibility", {
          detail: { active: false },
        })
      );
      return;
    }

    document.documentElement.classList.add("route-transition-lock");
    document.body.classList.add("route-transition-lock");
    window.dispatchEvent(
      new CustomEvent("roo:route-transition-visibility", {
        detail: { active: true },
      })
    );

    return () => {
      document.documentElement.classList.remove("route-transition-lock");
      document.body.classList.remove("route-transition-lock");
      window.dispatchEvent(
        new CustomEvent("roo:route-transition-visibility", {
          detail: { active: false },
        })
      );
    };
  }, [showRouteTransition]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    let cancelled = false;
    const runPrefetch = () => {
      if (cancelled) return;
      prefetchHomeSectionData().catch(() => {});
    };

    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(runPrefetch, { timeout: 1200 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback?.(id);
      };
    }

    const timeoutId = window.setTimeout(runPrefetch, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const currentHash = normalizeSectionHash(window.location.hash || "");
    const keepHash =
      location.pathname === "/" && isHomeSectionHash(currentHash)
        ? currentHash
        : "";
    const sanitizedSearch = sanitizeBrowserSearch(
      location.pathname || "/",
      location.search || ""
    );
    const nextUrl = `${location.pathname || "/"}${sanitizedSearch}${keepHash}`;
    const currentUrl = `${window.location.pathname || "/"}${window.location.search || ""}${window.location.hash || ""}`;

    if (currentUrl !== nextUrl && window.history?.replaceState) {
      window.history.replaceState(window.history.state, "", nextUrl);
    }
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const routeKey = `${location.pathname || "/"}${location.search || ""}`;
    const previousRouteKey = lastRouteKeyRef.current;
    lastRouteKeyRef.current = routeKey;

    if (!previousRouteKey || previousRouteKey === routeKey) {
      return;
    }

    const currentHash = normalizeSectionHash(window.location.hash || location.hash || "");
    const hasHomeSectionIntent =
      location.pathname === "/" && isHomeSectionHash(currentHash);
    const isModalBackgroundNavigation = Boolean(location.state?.backgroundLocation);

    if (isFlowRoute || isModalBackgroundNavigation || hasHomeSectionIntent) {
      return;
    }

    window.scrollTo({ top: 0, behavior: "auto" });
  }, [isFlowRoute, location.hash, location.pathname, location.search, location.state]);

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
        id="app-shell"
        className="relative min-h-screen flex flex-col text-white overflow-hidden
        bg-[linear-gradient(to_top,#00b7c0_0%,#006185_30%,#001f5a_65%,#000040_100%)]
        bg-scroll md:bg-fixed"
      >
        <div
          className={`fixed inset-0 z-[90] pointer-events-none transition-opacity duration-300 ${
            showRouteTransition ? "opacity-100" : "opacity-0"
          }`}
          aria-hidden="true"
          style={{
            background:
              "linear-gradient(180deg, rgba(1,8,34,0.32), rgba(1,8,34,0.18) 35%, rgba(1,8,34,0.28) 100%)",
          }}
        />
        {/* Background layers */}
        <div
          className="app-bg-grid-layer absolute inset-0 bg-[linear-gradient(45deg,rgba(255,255,255,0.05)_1px,transparent_1px)] 
                      bg-[size:40px_40px] opacity-50"
        ></div>
        <div
          className="app-bg-radial-layer absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.25),rgba(3,7,18,1) 80%)] 
                      "
        ></div>

        {/* Navbar and pages */}
        <main
          className="relative z-10 flex flex-col flex-1"
          style={{ paddingTop: "var(--header-offset)" }}
        >
          <Navbar routeShell={routeShell} />
          <ReservationBanner />

          <AnimatedRoutes
            setIsModalOpen={setIsModalOpen}
            routesLocation={routesLocation}
            routeKey={routesKey}
            initialHomeData={initialHomeData}
            initialRouteData={initialRouteData}
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
      <PerfDebugOverlay />
    </>
  );
}

function App() {
  // Example: add routes here to disable chat without refactoring.
  const tawkDisabledRoutes = [];
  // const tawkDisabledRoutes = ["/booking"]; // Disables chat on /booking and nested routes.

  return (
    <Router>
      <DeferredTawk disabledRoutes={tawkDisabledRoutes} />
      <AppContent routeShell="browser" />
    </Router>
  );
}

export default App;
