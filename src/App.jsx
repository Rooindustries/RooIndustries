import React, { useState, Suspense, lazy, useEffect } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { FaDiscord } from "react-icons/fa";
import { AnimatePresence, motion } from "framer-motion";
import Navbar from "./components/Navbar";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import ReservationBanner from "./components/ReservationBanner";
import BookingModal from "./components/BookingModal";

// Lazy-loaded pages
const Home = lazy(() => import("./pages/Home"));
const Benchmarks = lazy(() => import("./pages/Benchmarks"));
const Terms = lazy(() => import("./pages/Terms"));
const Privacy = lazy(() => import("./pages/PrivacyPolicy"));
const Reviews = lazy(() => import("./pages/Reviews"));
const Packages = lazy(() => import("./pages/Packages"));
const Faq = lazy(() => import("./pages/Faq"));
const Contact = lazy(() => import("./pages/Contact"));
const Book = lazy(() => import("./pages/Book"));
const Payment = lazy(() => import("./pages/Payment"));
const PaymentSuccess = lazy(() => import("./pages/PaymentSuccess"));
const Thankyou = lazy(() => import("./pages/Thankyou"));
const UpgradeXoc = lazy(() => import("./pages/UpgradeXoc"));
const Upgrade = lazy(() => import("./pages/Upgrade"));

// Referral system (also lazy)
const RefLogin = lazy(() => import("./pages/RefLogin"));
const RefDashboard = lazy(() => import("./pages/RefDashboard"));
const RefChangePassword = lazy(() => import("./pages/RefChangePassword"));
const RefForgot = lazy(() => import("./pages/RefForgot"));
const RefReset = lazy(() => import("./pages/RefReset"));
const RefRegister = lazy(() => import("./pages/RefRegister"));
const Tools = lazy(() => import("./pages/Tools"));

function RedirectToDiscord() {
  React.useEffect(() => {
    window.location.href = "https://discord.gg/M7nTkn9dxE";
  }, []);
  return null;
}

function RedirectPackagesToHome() {
  const location = useLocation();
  const navigate = useNavigate();
  const isPrerender =
    (typeof navigator !== "undefined" && navigator.userAgent === "ReactSnap") ||
    (typeof window !== "undefined" && window.__PRERENDER__ === true);

  useEffect(() => {
    if (isPrerender) return;
    const targetSearch = location.search || "";
    const targetHash = location.hash || "";
    navigate(`/${targetSearch}${targetHash}`, { replace: true });
  }, [isPrerender, location.search, location.hash, navigate]);

  if (isPrerender) {
    return <Packages />;
  }

  return null;
}

function AnimatedRoutes({ setIsModalOpen, routesLocation, routeKey }) {
  const baseLocation = useLocation();
  const location = routesLocation || baseLocation;
  const motionKey = routeKey || `${location.pathname}${location.search || ""}`;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={motionKey}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full flex flex-col flex-1"
      >
        <Routes location={location}>
          <Route path="/" element={<Home />} />
          <Route path="/packages" element={<RedirectPackagesToHome />} />
          <Route
            path="/benchmarks"
            element={<Benchmarks setIsModalOpen={setIsModalOpen} />}
          />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route
            path="/reviews"
            element={<Reviews setIsModalOpen={setIsModalOpen} />}
          />
          <Route path="/booking" element={<Book />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/faq" element={<Faq />} />
          <Route path="/discord" element={<RedirectToDiscord />} />
          <Route path="/payment" element={<Payment />} />
          <Route path="/payment-success" element={<PaymentSuccess />} />
          <Route path="/thank-you" element={<Thankyou />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/upgrade/:slug" element={<Upgrade />} />
          <Route path="/upgrade-xoc" element={<UpgradeXoc />} />

          {/* Referral system routes */}
          <Route path="/referrals/login" element={<RefLogin />} />
          <Route path="/referrals/dashboard" element={<RefDashboard />} />
          <Route
            path="/referrals/change-password"
            element={<RefChangePassword />}
          />
          <Route path="/referrals/forgot" element={<RefForgot />} />
          <Route path="/referrals/reset" element={<RefReset />} />
          <Route path="/referrals/Register" element={<RefRegister />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}

function AppContent() {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();
  const pathName = location.pathname || "";

  const backgroundLocation =
    location.state && location.state.backgroundLocation
      ? location.state.backgroundLocation
      : null;
  const isBookingRoute = pathName.startsWith("/booking");
  const isPaymentRoute = pathName === "/payment";
  const isPaymentSuccessRoute = pathName.startsWith("/payment-success");
  const isThankYouRoute = pathName.startsWith("/thank-you");
  const isFlowRoute =
    isBookingRoute ||
    isPaymentRoute ||
    isPaymentSuccessRoute ||
    isThankYouRoute;
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
      <Analytics />
      <SpeedInsights />

      <div
        className="relative min-h-screen flex flex-col text-white overflow-hidden 
        bg-[linear-gradient(to_top,#00b7c0_0%,#006185_30%,#001f5a_65%,#000040_100%)]
        bg-fixed"
      >
        {/* Background layers */}
        <div
          className="absolute inset-0 bg-[linear-gradient(45deg,rgba(255,255,255,0.05)_1px,transparent_1px)] 
                      bg-[size:40px_40px] opacity-50 animate-pulse"
        ></div>
        <div
          className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.25),rgba(3,7,18,1) 80%)] 
                      animate-pulse"
        ></div>

        {/* Navbar and pages */}
        <main className="relative z-10 flex flex-col flex-1 pt-10 sm:pt-24">
          <Navbar />
          <ReservationBanner />

          <Suspense
            fallback={
              <div className="pt-32 text-center text-slate-300 text-sm">
                Loading...
              </div>
            }
          >
            <AnimatedRoutes
              setIsModalOpen={setIsModalOpen}
              routesLocation={routesLocation}
              routeKey={routesKey}
            />
          </Suspense>
        </main>
      </div>
      <BookingModal open={isFlowRoute} onClose={closeBookingModal}>
        <Suspense
          fallback={
            <div className="pt-32 text-center text-slate-300 text-sm">
              Loading...
            </div>
          }
        >
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
    </>
  );
}

function App() {
  return (
    <Router>
      <AppContent />
    </Router>
  );
}

export default App;
