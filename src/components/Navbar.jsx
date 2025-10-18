import React, { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { FaBolt } from "react-icons/fa";

export default function Navbar() {
  const location = useLocation();
  const isActive = (path) => location.pathname === path;

  // disappear/appear on scrolling

  const [isVisible, setIsVisible] = useState(true);
  const [lastScrollY, setLastScrollY] = useState(0);

  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      if (currentScrollY > lastScrollY && currentScrollY > 50) {
        setIsVisible(false);
      } else {
        setIsVisible(true);
      }
      setLastScrollY(currentScrollY);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [lastScrollY]);

  return (
    <nav
      className={`fixed top-0 w-full z-50 px-2 sm:px-6 pt-3 transition-transform duration-500 ease-in-out ${
        isVisible ? "translate-y-0" : "-translate-y-full"
      }`}
    >
      <div
        className="mx-auto max-w-md sm:max-w-3xl flex items-center justify-between px-3 sm:px-6 py-2 sm:py-3
                   rounded-full bg-[#0f172a]/80 backdrop-blur-md
                   shadow-[0_0_25px_rgba(0,255,255,0.2)]
                   border border-cyan-400/10 overflow-hidden"
      >
        {/* Logo */}
        <Link
          to="/"
          className="bg-cyan-400 hover:bg-cyan-300 transition p-2 rounded-full flex-shrink-0"
        >
          <FaBolt className="text-black text-base sm:text-xl" />
        </Link>

        {/* Nav Links */}
        <div className="flex flex-wrap justify-center sm:flex-nowrap space-x-1 sm:space-x-4 text-white text-xs sm:text-sm md:text-base font-medium">
          <Link
            to="/"
            className={`px-2 sm:px-4 py-1 sm:py-1.5 rounded-full transition ${
              isActive("/") ? "bg-cyan-400 text-black" : "hover:text-cyan-400"
            }`}
          >
            Home
          </Link>
          <Link
            to="/benchmarks"
            className={`px-2 sm:px-4 py-1 sm:py-1.5 rounded-full transition ${
              isActive("/benchmarks")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            Benchmarks
          </Link>
          <Link
            to="/morereviews"
            className={`px-2 sm:px-4 py-1 sm:py-1.5 rounded-full transition ${
              isActive("/morereviews")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            More Reviews
          </Link>
          <Link
            to="/contact"
            className={`px-2 sm:px-4 py-1 sm:py-1.5 rounded-full transition ${
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
