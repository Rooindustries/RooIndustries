// App.jsx
import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Benchmarks from "./pages/Benchmarks";
import Contact from "./pages/Contact";
import { FaDiscord } from "react-icons/fa";
function App() {
  return (
    <Router>
      <div className="relative min-h-screen bg-[#030712] text-white overflow-hidden">
        <div
          className="absolute inset-0 bg-[linear-gradient(45deg,rgba(255,255,255,0.03)_1px,transparent_1px)] 
                        bg-[size:40px_40px] animate-pulse"
        ></div>
        <div
          className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.15),transparent_40%)] 
                        animate-pulse"
        ></div>

        <main className="relative z-10">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/benchmarks" element={<Benchmarks />} />
            <Route path="/contact" element={<Contact />} />
          </Routes>
        </main>
        <a
          href="https://discord.gg/M7nTkn9dxE" // replace with your server link
          target="_blank"
          rel="noopener noreferrer"
          className="fixed bottom-4 right-4 z-50 bg-blue-800 text-white p-4 rounded-full shadow-lg hover:bg-blue-500 transition-colors"
        >
          <FaDiscord size={24} />
        </a>
      </div>
    </Router>
  );
}

export default App;
