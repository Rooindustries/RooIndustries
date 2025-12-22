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
import CanvasVideo from "./components/CanvasVideo"; 
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
const Book = lazy(() => import("./pages/Book"));
const Payment = lazy(() => import("./pages/Payment"));
const PaymentSuccess = lazy(() => import("./pages/PaymentSuccess"));
const Thankyou = lazy(() => import("./pages/Thankyou"));
const UpgradeXoc = lazy(() => import("./pages/UpgradeXoc"));

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

  useEffect(() => {
    const targetSearch = location.search || "";
    const targetHash = location.hash || "";
    navigate(`/${targetSearch}${targetHash}`, { replace: true });
  }, [location.search, location.hash, navigate]);

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
        className="w-full"
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
          <Route path="/faq" element={<Faq />} />
          <Route path="/discord" element={<RedirectToDiscord />} />
          <Route path="/payment" element={<Payment />} />
          <Route path="/payment-success" element={<PaymentSuccess />} />
          <Route path="/thank-you" element={<Thankyou />} />
          <Route path="/tools" element={<Tools />} />
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
  const [useStaticLogo, setUseStaticLogo] = useState(false);
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
    isBookingRoute || isPaymentRoute || isPaymentSuccessRoute || isThankYouRoute;
  const fallbackLocation =
    isFlowRoute && !backgroundLocation
      ? { ...location, pathname: "/", search: "", hash: "" }
      : null;
  const routesLocation = backgroundLocation || fallbackLocation || location;
  const routesKey = `${routesLocation.pathname}${routesLocation.search || ""}`;

  const closeBookingModal = () => {
    const target =
      backgroundLocation || { pathname: "/", search: "", hash: "", state: null };
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

        <div
          className="relative min-h-screen text-white overflow-hidden 
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

          {/* Roo Industries Logo Wrapper */}
          <a
            href="/"
            className={`roo-logo group z-50 flex items-center justify-center
          transition-transform duration-300 hover:scale-105
          transition-opacity duration-500 opacity-100
          outline-none focus:outline-none border-none
          
          relative top-6 w-full mb-4
          min-[1280px]:absolute min-[1280px]:fixed min-[1280px]:md:absolute
          min-[1280px]:top-6 min-[1280px]:left-10 
          min-[1280px]:w-auto min-[1280px]:justify-start 
          min-[1280px]:mb-0`}
          >
            
            {/* --- DOUBLE LAYER GLOW ENGINE (REFINED) --- */}
            
            {/* Layer 1: The Ambient Body (Deep Blue)
                - Idle: 80% (High visibility)
                - Hover: 90% + small scale (Subtle boost, not explosion)
            */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 
                            w-40 h-14 bg-blue-500 rounded-full blur-[50px]
                            opacity-80 group-hover:opacity-90 group-hover:scale-110 
                            transition-all duration-500 ease-out z-[-1]" 
            />

            {/* Layer 2: The Hot Core (Bright Cyan)
                - Idle: 60% (Visible core)
                - Hover: 80% + small scale (Gets hotter, but not blinding)
            */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 
                            w-32 h-10 bg-cyan-400 rounded-full blur-[35px]
                            opacity-60 group-hover:opacity-80 group-hover:scale-110 
                            transition-all duration-500 ease-out z-[-1]" 
            />

            {useStaticLogo ? (
              <img
                src="/logo.webp"
                alt="Roo Industries Logo"
                width={500}
                height={267}
                className="w-48 sm:w-56 md:w-60 relative z-10"
                loading="eager"
                fetchPriority="high"
              />
            ) : (
              <CanvasVideo
                src="/logo-animated.webm"
                poster="/logo.webp"
                alt="Roo Industries logo"
                onError={() => setUseStaticLogo(true)}
                className="w-48 sm:w-56 md:w-60 roo-logo-video relative z-10
                drop-shadow-[0_0_10px_rgba(14,165,233,0.3)]
                transition-all duration-500" 
              />
            )}
          </a>

          {/* Navbar and pages */}
          <main className="relative z-10 pt-10 sm:pt-24">
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
