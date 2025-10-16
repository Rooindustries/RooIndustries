// App.jsx
import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Benchmarks from "./pages/Benchmarks";

function App() {
  return (
    <Router>
      <div className="relative min-h-screen bg-[#030712] text-white overflow-hidden">
        {/* Grid lines */}
        <div
          className="absolute inset-0 bg-[linear-gradient(45deg,rgba(255,255,255,0.03)_1px,transparent_1px)] 
                        bg-[size:40px_40px] animate-pulse"
        ></div>

        {/* Radial glow */}
        <div
          className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.15),transparent_40%)] 
                        animate-pulse"
        ></div>

        <main className="relative z-10">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/benchmarks" element={<Benchmarks />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
