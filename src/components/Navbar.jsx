import React from "react";
import { Link, useLocation } from "react-router-dom";
import { FaBolt } from "react-icons/fa";

export default function Navbar() {
  const location = useLocation();
  const isActive = (path) => location.pathname === path;

  return (
    <nav className="fixed top-0 w-full z-50 px-4 sm:px-8 pt-4">
      <div
        className="max-w-3xl mx-auto flex items-center justify-between px-6 py-3 rounded-full 
                   bg-[#0f172a]/80 backdrop-blur-md 
                   shadow-[0_0_25px_rgba(0,255,255,0.2)] 
                   border border-cyan-400/10"
      >
        <Link
          to="/"
          className="bg-cyan-400 hover:bg-cyan-300 transition p-2 rounded-full"
        >
          <FaBolt className="text-black text-lg" />
        </Link>

        <div className="flex space-x-4 text-white text-sm font-medium">
          <Link
            to="/"
            className={`px-4 py-1.5 rounded-full transition ${
              isActive("/") ? "bg-cyan-400 text-black" : "hover:text-cyan-400"
            }`}
          >
            Home
          </Link>
          <Link
            to="/benchmarks"
            className={`px-4 py-1.5 rounded-full transition ${
              isActive("/benchmarks")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            Benchmarks
          </Link>
          <Link
            to="/morereviews"
            className={`px-4 py-1.5 rounded-full transition ${
              isActive("/morereviews")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            More Reviews
          </Link>
          <Link
            to="/contact"
            className={`px-4 py-1.5 rounded-full transition ${
              isActive("/contact")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            Contact
          </Link>
        </div>
      </div>
    </nav>
  );
}
