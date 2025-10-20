// App.jsx
import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Benchmarks from "./pages/Benchmarks";
import Contact from "./pages/Contact";
import Terms from "./pages/Terms";
import Privacy from "./pages/PrivacyPolicy";
import { FaDiscord } from "react-icons/fa";
import Reviews from "./pages/Reviews";
import Navbar from "./components/Navbar";

function App() {
  return (
    <Router>
      <div
        className="relative min-h-screen text-white overflow-hidden 
              bg-[linear-gradient(to_bottom,#00d5df_0%,#0072a0_30%,#002c73_65%,#000058_100%)]
              bg-fixed"
      >
        {/* Subtle grid overlay */}
        <div
          className="absolute inset-0 bg-[linear-gradient(45deg,rgba(255,255,255,0.05)_1px,transparent_1px)] 
                     bg-[size:40px_40px] opacity-50 animate-pulse"
        ></div>

        {/* cyan radial glow at center */}
        <div
          className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.25),rgba(3,7,18,1) 80%)] 
                     animate-pulse"
        ></div>

        {/* Roo Industries Logo */}
        <a
          href="/"
          className="z-50 flex justify-center sm:justify-start items-center 
             transition-transform duration-300 hover:scale-105
             absolute sm:fixed md:absolute 
             top-6 left-0 sm:left-8 md:left-10 w-full sm:w-auto
             max-[480px]:relative max-[480px]:top-6 max-[480px]:mb-4"
        >
          <img
            src="/logo.png"
            alt="Roo Industries Logo"
            className="w-40 sm:w-48 md:w-56 drop-shadow-[0_0_25px_rgba(14,165,233,0.4)] 
               hover:drop-shadow-[0_0_35px_rgba(14,165,233,0.6)] transition-all duration-500"
          />
        </a>

        {/* Navbar */}
        <main className="relative z-10 pt-10 sm:pt-24">
          <Navbar />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/benchmarks" element={<Benchmarks />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/morereviews" element={<Reviews />} />
          </Routes>
        </main>

        {/* === Discord Icon === */}
        <a
          href="https://discord.gg/M7nTkn9dxE"
          target="_blank"
          rel="noopener noreferrer"
          className="fixed bottom-6 sm:bottom-12 right-6 sm:right-12 z-50
                     bg-blue-800 text-white p-4 sm:p-5 rounded-full
                     shadow-2xl hover:bg-blue-500
                     transition-transform duration-300 hover:scale-110
                     animate-[float_3s_ease-in-out_infinite]
                     drop-shadow-[0_0_15px_rgba(14,165,233,0.35)]"
        >
          <FaDiscord className="w-8 h-8 sm:w-11 sm:h-11" />
        </a>
      </div>
    </Router>
  );
}

export default App;
