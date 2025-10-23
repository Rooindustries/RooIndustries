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
        bg-[linear-gradient(to_top,#00b7c0_0%,#006185_30%,#001f5a_65%,#000040_100%)]
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
             group bg-gradient-to-br from-[#3b82f6] via-[#2563eb] to-[#1e40af]
             text-white p-4 sm:p-5 rounded-full
             shadow-[0_0_25px_rgba(56,189,248,0.6),0_0_50px_rgba(56,189,248,0.3)]
             transition-all duration-300 hover:scale-125 hover:shadow-[0_0_45px_rgba(56,189,248,0.9),0_0_90px_rgba(56,189,248,0.4)]
             before:absolute before:inset-0 before:rounded-full
             before:bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.35),transparent_70%)]
             before:blur-xl before:-z-10 animate-[float_3s_ease-in-out_infinite]"
        >
          <FaDiscord
            className="w-8 h-8 sm:w-11 sm:h-11 text-white drop-shadow-[0_0_15px_rgba(56,189,248,0.9)]
               group-hover:drop-shadow-[0_0_25px_rgba(56,189,248,1)] transition-all duration-300"
          />
        </a>
      </div>
    </Router>
  );
}

export default App;
