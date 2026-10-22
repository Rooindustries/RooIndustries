import React, { useState, useEffect, useLayoutEffect, Suspense, lazy, useRef } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  useLocation,
  useNavigate,
  useNavigationType,
  Navigate,
} from "react-router-dom";
import Navbar from "./components/Navbar";
import JsonLd from "./next/JsonLd";
import { isProductionBrowser } from "./lib/productionBrowser";
import SalesTelemetry from "./components/SalesTelemetry";
import { SpeedInsights } from "@vercel/speed-insights/react";
import ReservationBanner from "./components/ReservationBanner";
import { BookingDialogReady } from "./lib/bookingDialogHold";
import IntercomMessenger from "./components/IntercomMessenger";
import { subscribePerfDebugChanges, syncPerfDebugFromEnvironment } from "./lib/perfDebug";
import { initializePerformanceProfile } from "./lib/performanceProfile";
import { getConfirmationPage, preloadConfirmationPage } from "./lib/confirmationPages";
import {
  consumeRouteTransitionIntent,
  isHomeSectionHash,
  normalizeSectionHash,
} from "./lib/sectionNavigation";
import { sanitizeBrowserSearch } from "./lib/browserSearch";
import { prefetchHomeSectionData } from "./lib/homeSectionData";
import { whenUserInteracts } from "./lib/firstInteraction";
import { migrateCheckoutStorageToSession } from "./lib/checkoutStorage";
import { getPublicContent, getPublicContentPendingCount } from "./lib/publicContentClient";
import { useBookingDialogPending } from "./lib/bookingDialogHold";
import { setVisibleTimeout } from "./lib/visibleTimeout";

const Home = lazy(() => import("./legacyPages/Home"));
const AboutPage = lazy(() => import("./legacyPages/About"));
const Packages = lazy(() => import("./legacyPages/Packages"));
const FaqPage = lazy(() => import("./legacyPages/Faq"));
const Contact = lazy(() => import("./legacyPages/Contact"));
const Privacy = lazy(async () => {
  const [{ default: Page }, initialData] = await Promise.all([
    import("./legacyPages/PrivacyPolicy"),
    getPublicContent("privacy-policy").catch(() => null),
  ]);
  return { default: (props) => <Page {...props} initialData={props.initialData || initialData} /> };
});
const PerfDebugOverlay = lazy(() =>
  import("./components/PerfDebugOverlay").catch(() => ({ default: () => null }))
);
const Reviews = lazy(() => import("./legacyPages/Reviews"));
const Tools = lazy(() => import("./legacyPages/Tools"));
const RefLogin = lazy(() => import("./legacyPages/RefLogin"));
const RefDashboard = lazy(() => import("./legacyPages/RefDashboard"));
const RefChangePassword = lazy(() => import("./legacyPages/RefChangePassword"));
const RefForgot = lazy(() => import("./legacyPages/RefForgot"));
const RefReset = lazy(() => import("./legacyPages/RefReset"));
const RefRegister = lazy(() => import("./legacyPages/RefRegister"));
const RefVerifyRegistration = lazy(() => import("./legacyPages/RefVerifyRegistration"));
const Benchmarks = lazy(() => import("./legacyPages/Benchmarks"));
const Terms = lazy(() => import("./legacyPages/Terms"));
const Book = lazy(() => import("./legacyPages/Book"));
const Payment = lazy(() => import("./legacyPages/Payment"));
const LazyPaymentSuccess = lazy(() => preloadConfirmationPage("paid"));
const LazyThankyou = lazy(() => preloadConfirmationPage("free"));
const UpgradeXoc = lazy(() => import("./legacyPages/UpgradeXoc"));
const Upgrade = lazy(() => import("./legacyPages/Upgrade"));
const Download = lazy(() => import("./legacyPages/Download"));
const BookingModal = lazy(() => import("./components/BookingModal"));

const MeetTheTeam = lazy(() => import("./legacyPages/MeetTheTeam"));
const NotFound = lazy(() => import("./legacyPages/NotFound"));

const INTERCOM_DISABLED_ROUTES = ["/booking", "/payment"];
const BACKGROUND_READY_MAX_WAIT_MS = 3000;

const isReferralVerificationHash = (hash) => {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  return /^[A-Za-z0-9_-]{40,60}$/.test(String(params.get("token") || ""));
};

const isReferralResetHash = (hash) => {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const legacyToken = String(params.get("token") || "");
  if (/^[a-f0-9]{64}$/i.test(legacyToken)) return true;
  return (
    params.get("type") === "recovery" &&
    Boolean(params.get("access_token")) &&
    Boolean(params.get("refresh_token"))
  );
};

const DeferredTelemetry = () => {
  const location = useLocation();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(false);
    if (typeof window === "undefined") return undefined;
    const protectedPath = [
      "/referrals",
      "/booking",
      "/payment",
      "/payment-success",
      "/thank-you",
    ].some(
      (prefix) =>
        location.pathname === prefix || location.pathname.startsWith(`${prefix}/`)
    );
    if (protectedPath) return undefined;
    if (!isProductionBrowser()) return undefined;

    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(() => setEnabled(true), {
        timeout: 6000,
      });
      return () => window.cancelIdleCallback?.(idleId);
    }

    const timeoutId = window.setTimeout(() => setEnabled(true), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [location.pathname]);

  if (!enabled) return null;

  return (
    <>
      <SpeedInsights />
    </>
  );
};

const IntercomRuntime = ({ disabledRoutes, disabled }) => {
  return (
    <IntercomMessenger disabledRoutes={disabledRoutes} disabled={disabled} />
  );
};

const RouteFallback = () => {
  useBookingDialogPending(true);
  return <div className="pt-16 text-center text-ink-secondary text-sm">Loading...</div>;
};

const withRouteSuspense = (node, fallback = <RouteFallback />) => (
  <Suspense fallback={fallback}>{node}</Suspense>
);

const PerfDebugRuntime = () => {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const sync = () => {
      if (syncPerfDebugFromEnvironment().enabled) setLoaded(true);
    };
    sync();
    return subscribePerfDebugChanges(sync);
  }, []);

  return loaded ? withRouteSuspense(<PerfDebugOverlay />, null) : null;
};

function RedirectToDiscord() {
  React.useEffect(() => {
    window.location.href = "https://discord.com/invite/qs5HKNyazD";
  }, []);
  return null;
}

function AnimatedRoutes({
  setIsModalOpen,
  routesLocation,
  routeKey,
  initialHomeData,
  initialRouteData,
  heroHeadingTag,
  initialRouteComponent,
  initialRoutePath,
  initialHomeComponent,
  notFound,
}) {
  const baseLocation = useLocation();
  const location = routesLocation || baseLocation;
  const motionKey = routeKey || location.pathname;
  const [initialEntryKey, setInitialEntryKey] = useState(baseLocation.key);
  const [hydrated, setHydrated] = useState(false);
  const initialContent = baseLocation.key === initialEntryKey ? initialRouteData : null;
  const PaymentSuccess = getConfirmationPage("paid") || LazyPaymentSuccess;
  const Thankyou = getConfirmationPage("free") || LazyThankyou;
  const EagerPage = initialRoutePath === location.pathname
    ? initialRouteComponent
    : location.pathname === "/" ? initialHomeComponent : null;

  React.useLayoutEffect(() => {
    if (initialRouteComponent || initialHomeComponent) setHydrated(true);
  }, [initialRouteComponent, initialHomeComponent]);

  useEffect(() => {
    if (initialEntryKey !== null && baseLocation.key !== initialEntryKey) {
      setInitialEntryKey(null);
    }
  }, [baseLocation.key, initialEntryKey]);

  const renderPage = (node) => {
    return EagerPage ? <EagerPage {...node.props} /> : node;
  };

  const routes = (
      <div key={motionKey} data-route-key={motionKey} className="w-full flex flex-col flex-1">
        {notFound && location.pathname === initialRoutePath ? (
          <Routes location={location}>
            <Route path="*" element={<NotFound />} />
          </Routes>
        ) : (
        <Routes location={location}>
          <Route path="/" element={renderPage(<Home initialData={initialHomeData} heroHeadingTag={heroHeadingTag} />)} />
          <Route
            path="/packages"
            element={renderPage(<Packages initialData={initialRouteData?.packages || null} />)}
          />
          <Route
            path="/benchmarks"
            element={renderPage(
              <Benchmarks
                setIsModalOpen={setIsModalOpen}
                initialData={initialRouteData?.benchmarks || null}
              />
            )}
          />
          <Route path="/about" element={renderPage(<AboutPage />)} />
          <Route path="/privacy" element={renderPage(<Privacy initialData={initialRouteData?.privacy || null} />)} />
          <Route path="/terms" element={renderPage(<Terms initialData={initialRouteData?.terms || null} />)} />
          <Route
            path="/reviews"
            element={renderPage(<Reviews setIsModalOpen={setIsModalOpen} initialData={initialContent?.reviewsGallery || null} />)}
          />
          <Route path="/booking" element={renderPage(<Book />)} />
          <Route path="/contact" element={renderPage(<Contact initialData={initialRouteData?.contact || null} />)} />
          <Route
            path="/faq"
            element={renderPage(<FaqPage initialData={initialHomeData} />)}
          />
          <Route path="/discord" element={<RedirectToDiscord />} />
          <Route path="/payment" element={renderPage(<Payment />)} />
          <Route
            path="/payment-success"
            element={renderPage(<PaymentSuccess />)}
          />
          <Route path="/thank-you" element={renderPage(<Thankyou />)} />
          <Route
            path="/tools"
            element={renderPage(
              <Tools initialData={initialContent?.tools || null} />
            )}
          />
          <Route
            path="/meet-the-team"
            element={renderPage(
              <MeetTheTeam initialData={initialContent?.meetTheTeam || null} />
            )}
          />
          <Route
            path="/upgrade/:slug"
            element={renderPage(<Upgrade />)}
          />
          <Route
            path="/upgrade-xoc"
            element={renderPage(<UpgradeXoc />)}
          />
          <Route
            path="/downloads/:slug"
            element={renderPage(<Download />)}
          />

          <Route
            path="/referrals/login"
            element={renderPage(<RefLogin />)}
          />
          <Route
            path="/referrals/dashboard"
            element={renderPage(<RefDashboard />)}
          />
          <Route
            path="/referrals/change-password"
            element={renderPage(<RefChangePassword />)}
          />
          <Route
            path="/referrals/forgot"
            element={renderPage(<RefForgot />)}
          />
          <Route
            path="/referrals/reset"
            element={renderPage(<RefReset />)}
          />
          <Route
            path="/referrals/register"
            element={renderPage(<RefRegister />)}
          />
          <Route
            path="/referrals/verify"
            element={renderPage(<RefVerifyRegistration />)}
          />
          <Route
            path="/referrals/Register"
            element={<Navigate to="/referrals/register" replace />}
          />
          <Route path="*" element={renderPage(<NotFound />)} />
        </Routes>
        )}
      </div>
  );

  if (!EagerPage) return withRouteSuspense(routes);
  if (!hydrated) return routes;
  return <>{routes}{withRouteSuspense(null)}</>;
}

export function AppContent({
  initialHomeData = null,
  initialRouteData = null,
  routeJsonLd = null,
  initialRouteComponent = null,
  initialRoutePath = null,
  initialHomeComponent = null,
  initialBookingModalComponent = null,
  routeShell = "browser",
  notFound = false,
}) {
  const InitialRouteComponent = initialRouteComponent;
  const PaymentSuccess = getConfirmationPage("paid") || LazyPaymentSuccess;
  const Thankyou = getConfirmationPage("free") || LazyThankyou;
  const FlowModal = initialBookingModalComponent || BookingModal;
  const [, setIsModalOpen] = useState(false);
  const [showRouteTransition, setShowRouteTransition] = useState(false);
  const [storedBackground, setStoredBackground] = useState(null);
  const [paymentHoldContainer, setPaymentHoldContainer] = useState(null);

  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const historyInitializedRef = useRef(false);
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

  const isBookingRoute = pathName === "/booking";
  const isPaymentRoute = pathName === "/payment";
  const isPaymentSuccessRoute = pathName === "/payment-success";
  const isThankYouRoute = pathName === "/thank-you";
  const isFlowRoute =
    isBookingRoute ||
    isPaymentRoute ||
    isPaymentSuccessRoute ||
    isThankYouRoute;
  const flowContentKey = isPaymentSuccessRoute || isThankYouRoute ? pathName : "checkout";
  const loadedOnFlowRouteRef = useRef(isFlowRoute);
  useEffect(() => {
    if (!isFlowRoute) loadedOnFlowRouteRef.current = false;
  }, [isFlowRoute]);

  useEffect(() => {
    migrateCheckoutStorageToSession();
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
    let cancelScheduled = () => {};
    const runPrefetch = () => {
      if (cancelled) return;
      prefetchHomeSectionData().catch(() => {});
    };

    const schedulePrefetch = () => {
      if (cancelled) return;
      if ("requestIdleCallback" in window) {
        const id = window.requestIdleCallback(runPrefetch, { timeout: 1200 });
        cancelScheduled = () => window.cancelIdleCallback?.(id);
        return;
      }
      const timeoutId = window.setTimeout(runPrefetch, 200);
      cancelScheduled = () => window.clearTimeout(timeoutId);
    };

    if (initialHomeData) {
      whenUserInteracts().then(schedulePrefetch);
    } else {
      schedulePrefetch();
    }

    return () => {
      cancelled = true;
      cancelScheduled();
    };
  }, []);

  useEffect(() => {
    if (routeShell !== "memory" || typeof window === "undefined") return;
    const restoreBrowserEntry = (event) => {
      if (!event.state?.__rooLegacy) return;
      navigate(
        `${window.location.pathname}${sanitizeBrowserSearch(
          window.location.pathname,
          window.location.search
        )}${window.location.hash}`,
        { replace: true, state: event.state.usr || null }
      );
    };
    window.addEventListener("popstate", restoreBrowserEntry);
    return () => window.removeEventListener("popstate", restoreBrowserEntry);
  }, [navigate, routeShell]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const rawHash = location.hash || (
      window.location.pathname === location.pathname ? window.location.hash : ""
    );
    const currentHash = normalizeSectionHash(rawHash);
    const keepHash =
      location.pathname === "/" && isHomeSectionHash(currentHash)
        ? currentHash
        : location.pathname === "/referrals/verify" &&
            isReferralVerificationHash(rawHash)
          ? rawHash
          : location.pathname === "/referrals/reset" && isReferralResetHash(rawHash)
            ? rawHash
            : "";
    const sanitizedSearch = sanitizeBrowserSearch(location.pathname || "/", location.search || "");
    const nextUrl = `${location.pathname || "/"}${sanitizedSearch}${keepHash}`;
    const currentUrl = `${window.location.pathname || "/"}${window.location.search || ""}${window.location.hash || ""}`;

    if (routeShell === "memory") {
      const initial = !historyInitializedRef.current;
      historyInitializedRef.current = true;
      const state = {
        ...window.history.state,
        // Retain Next's router tree and any checkout state on first hydration.
        usr: initial ? window.history.state?.usr ?? null : location.state,
        __rooLegacy: true,
      };
      // Navbar section links may already have pushed their browser entry.
      if (!initial && navigationType === "PUSH" && currentUrl !== nextUrl) {
        window.history.pushState(state, "", nextUrl);
      } else {
        window.history.replaceState(state, "", nextUrl);
      }
    } else if (currentUrl !== nextUrl && window.history?.replaceState) {
      window.history.replaceState(window.history.state, "", nextUrl);
    }
  }, [location.pathname, location.search, location.hash, location.key, location.state, navigationType, routeShell]);

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
      setStoredBackground(stateBackground);
      return;
    }
    if (!isFlowRoute) {
      const currentBackground = {
        pathname: location.pathname,
        search: location.search || "",
        hash: location.hash || "",
      };
      writeStoredBackground(currentBackground);
      setStoredBackground(currentBackground);
      return;
    }

    setStoredBackground(readStoredBackground());
  }, [location.pathname, location.search, location.hash, location.state, isFlowRoute]);

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
  const routesKey = routesLocation.pathname;
  const initialRoutesPathRef = useRef(routesLocation.pathname);
  const [backgroundReveal, setBackgroundReveal] = useState({ key: null, held: false });
  if (
    backgroundReveal.key === null &&
    isFlowRoute &&
    loadedOnFlowRouteRef.current &&
    routesLocation.pathname !== initialRoutesPathRef.current
  ) {
    setBackgroundReveal({ key: routesKey, held: true });
  } else if (backgroundReveal.held && !isFlowRoute) {
    setBackgroundReveal({ ...backgroundReveal, held: false });
  }
  const backgroundHeld = backgroundReveal.held && isFlowRoute && backgroundReveal.key === routesKey;

  useLayoutEffect(() => {
    if (!backgroundHeld) return undefined;
    const key = backgroundReveal.key;
    let frame = 0;
    let lastHeight = -1;
    let stableFrames = 0;
    const reveal = () =>
      setBackgroundReveal(current => (current.key === key && current.held ? { ...current, held: false } : current));
    const check = () => {
      const main = document.getElementById("main-content");
      const mounted = main?.querySelector("[data-route-key]")?.dataset.routeKey === key;
      const height = main ? main.getBoundingClientRect().height : -1;
      stableFrames = mounted && getPublicContentPendingCount() === 0 && height === lastHeight ? stableFrames + 1 : 0;
      lastHeight = height;
      if (stableFrames >= 2) {
        reveal();
        return;
      }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    const cancelMaxWait = setVisibleTimeout(reveal, BACKGROUND_READY_MAX_WAIT_MS);
    return () => {
      cancelAnimationFrame(frame);
      cancelMaxWait();
    };
  }, [backgroundHeld, backgroundReveal.key]);

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
      {routeJsonLd && location.pathname === initialRoutePath ? <JsonLd data={routeJsonLd} /> : null}
      <DeferredTelemetry />
      <SalesTelemetry />
      <IntercomRuntime
        disabledRoutes={INTERCOM_DISABLED_ROUTES}
        disabled={isFlowRoute}
      />

      <div
        id="app-shell"
        className="relative min-h-screen flex flex-col overflow-hidden bg-scroll md:bg-fixed"
      >
        <div
          className={`route-transition-veil fixed inset-0 z-[90] pointer-events-none transition-opacity duration-300 ${
            showRouteTransition ? "opacity-100" : "opacity-0"
          }`}
          aria-hidden="true"
        />
        <div className="app-bg-grid-layer absolute inset-0"></div>
        <div className="app-bg-radial-layer absolute inset-0"></div>

        <Navbar routeShell={routeShell} />
        <ReservationBanner hidden={isFlowRoute && !isPaymentRoute} inline={isPaymentRoute} inlineContainer={paymentHoldContainer} />

        <main
          id="main-content"
          tabIndex={-1}
          className={`relative z-10 flex flex-col flex-1 focus:outline-none${backgroundHeld ? " invisible" : ""}`}
          style={{ paddingTop: "var(--header-offset)" }}
        >
          <AnimatedRoutes
            setIsModalOpen={setIsModalOpen}
            routesLocation={routesLocation}
            routeKey={routesKey}
            initialHomeData={initialHomeData}
            initialRouteData={initialRouteData}
            heroHeadingTag={isPaymentSuccessRoute || isThankYouRoute ? "h2" : "h1"}
            initialRouteComponent={initialRouteComponent}
            initialRoutePath={initialRoutePath}
            initialHomeComponent={initialHomeComponent}
            notFound={notFound}
          />
        </main>
      </div>
      {isFlowRoute && (
        <Suspense fallback={null}>
          <FlowModal
            open
            onClose={closeBookingModal}
            skipInitialSizeAnimation={isPaymentSuccessRoute || isThankYouRoute || loadedOnFlowRouteRef.current}
            contentKey={flowContentKey}
            routePath={location.pathname}
            reservationRef={setPaymentHoldContainer}
          >
            <Suspense
              key={flowContentKey}
              fallback={<RouteFallback />}
            >
              {initialRoutePath === pathName && InitialRouteComponent ? (
                <InitialRouteComponent hideFooter compact={isBookingRoute} />
              ) : isPaymentSuccessRoute ? (
                <PaymentSuccess hideFooter />
              ) : isThankYouRoute ? (
                <Thankyou hideFooter />
              ) : isPaymentRoute ? (
                <Payment hideFooter />
              ) : (
                <Book hideFooter compact />
              )}
              <BookingDialogReady />
            </Suspense>
          </FlowModal>
        </Suspense>
      )}
      <PerfDebugRuntime />
    </>
  );
}

function App() {
  return (
    <Router>
      <AppContent routeShell="browser" />
    </Router>
  );
}

export default App;
