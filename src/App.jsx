import React, { useState, Suspense, lazy } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  useLocation,
} from "react-router-dom";
import { FaDiscord } from "react-icons/fa";
import { AnimatePresence, motion } from "framer-motion";
import Navbar from "./components/Navbar";

// Lazy-loaded pages
const Home = lazy(() => import("./pages/Home"));
const Benchmarks = lazy(() => import("./pages/Benchmarks"));
const Contact = lazy(() => import("./pages/Contact"));
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
const RefRegister = lazy(() => import("./components/RefRegister"));

function RedirectToDiscord() {
  React.useEffect(() => {
    window.location.href = "https://discord.gg/M7nTkn9dxE";
  }, []);
  return null;
}

function AnimatedRoutes({ setIsModalOpen }) {
  const location = useLocation();

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full"
      >
        <Routes location={location}>
          <Route path="/" element={<Home />} />
          <Route path="/packages" element={<Packages />} />
          <Route
            path="/benchmarks"
            element={<Benchmarks setIsModalOpen={setIsModalOpen} />}
          />
          <Route path="/contact" element={<Contact />} />
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

          {/* 🔥 NEW: secret upgrade route (only share the URL manually) */}
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

// ----------------------------------------------------------------------
// MAIN APP COMPONENT
// ----------------------------------------------------------------------
function App() {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <Router>
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

        {/* Roo Industries Logo */}
        <a
          href="/"
          className={`roo-logo z-50 flex justify-center sm:justify-start items-center 
      transition-transform duration-300 hover:scale-105
      absolute sm:fixed md:absolute 
      top-6 left-0 sm:left-8 md:left-10 w-full sm:w-auto
      max-[480px]:relative max-[480px]:top-6 max-[480px]:mb-4 
      transition-opacity duration-500 opacity-100
      outline-none focus:outline-none border-none`}
        >
          <img
            src="/logo.webp"
            alt="Roo Industries Logo"
            className="w-40 sm:w-48 md:w-56 drop-shadow-[0_0_25px_rgba(14,165,233,0.4)] 
                hover:drop-shadow-[0_0_35px_rgba(14,165,233,0.6)] transition-all duration-500"
            loading="eager"
            fetchPriority="high"
          />
        </a>

        {/* Navbar and pages */}
        <main className="relative z-10 pt-10 sm:pt-24">
          <Navbar />

          <Suspense
            fallback={
              <div className="pt-32 text-center text-slate-300 text-sm">
                Loading…
              </div>
            }
          >
            <AnimatedRoutes setIsModalOpen={setIsModalOpen} />
          </Suspense>
        </main>

        {/* Discord Icon */}
        <a
          href="https://discord.gg/M7nTkn9dxE"
          target="_blank"
          rel="noopener noreferrer"
          className="fixed bottom-6 sm:bottom-12 right-6 sm:right-12 z-50 flex flex-col items-center gap-1 group animate-[float_3s_ease-in-out_infinite]"
        >
          <span
            className="text-[13px] sm:text-sm font-semibold text-sky-200/80 
                drop-shadow-[0_0_6px_rgba(14,165,233,0.4)] 
                group-hover:text-sky-300 transition-colors duration-300"
          >
            Join the Discord!
          </span>

          <div
            className="relative bg-gradient-to-br from-[#295bbf] via-[#1f48a0] to-[#162f74]
                text-white p-4 sm:p-5 rounded-full
                shadow-[0_0_25px_rgba(56,189,248,0.4),0_0_45px_rgba(56,189,248,0.2)]
                transition-all duration-300 hover:scale-125 
                hover:shadow-[0_0_45px_rgba(56,189,248,0.8),0_0_90px_rgba(56,189,248,0.4)]
                before:absolute before:inset-0 before:rounded-full
                before:bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.25),transparent_70%)]
                before:blur-xl before:-z-10"
          >
            <FaDiscord
              className="w-8 h-8 sm:w-11 sm:h-11 text-white drop-shadow-[0_0_15px_rgba(56,189,248,0.7)]
                  group-hover:drop-shadow-[0_0_25px_rgba(56,189,248,1)] 
                  transition-all duration-300"
            />
          </div>
        </a>
      </div>
    </Router>
  );
}

export default App;
