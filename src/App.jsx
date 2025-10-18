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
      <div className="relative min-h-screen text-white overflow-hidden bg-gradient-to-br from-[#1a2335] via-[#0b1120] to-[#030712]">
        {/* Subtle grid overlay */}
        <div
          className="absolute inset-0 bg-[linear-gradient(45deg,rgba(255,255,255,0.03)_1px,transparent_1px)] 
                      bg-[size:40px_40px] opacity-40 animate-pulse"
        ></div>

        {/* Soft cyan glow at center */}
        <div
          className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.12),transparent_45%)] 
                      animate-pulse"
        ></div>

        <main className="relative z-10">
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

        {/* discord icon  */}
        <a
          href="https://discord.gg/M7nTkn9dxE"
          target="_blank"
          rel="noopener noreferrer"
          className="fixed bottom-8 sm:bottom-12 right-6 sm:right-12 z-50 
             bg-blue-800 text-white p-4 sm:p-5 rounded-full shadow-2xl 
             hover:bg-blue-500 transition-transform duration-300 hover:scale-110 
             animate-[float_3s_ease-in-out_infinite]"
        >
          <FaDiscord size={34} className="sm:size-[44px]" />
        </a>
      </div>
    </Router>
  );
}

export default App;
