import React, { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import BackButton from "./BackButton";

export default function Navbar() {
  const location = useLocation();
  const isActive = (path) => location.pathname === path;

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
      className={`fixed top-0 w-full z-50 px-2 sm:px-8 
              pt-4 max-[480px]:pt-14
              transition-transform duration-500 ease-in-out ${
                isVisible ? "translate-y-0" : "-translate-y-full"
              }`}
    >
      <div
        className="
      relative mx-auto 
      max-w-md sm:max-w-3xl 
      md:max-w-[80%] xl:max-w-3xl  /* Tablet + laptop smaller */
      flex items-center justify-center
      px-3 sm:px-6 md:px-4 py-2 sm:py-3 md:py-2
      rounded-full bg-[#0f172a]/80 backdrop-blur-md
      shadow-[0_0_25px_rgba(0,255,255,0.2)]
      border border-cyan-400/10 overflow-hidden
      transition-all duration-300
    "
      >
        {/* Back Button (left) */}
        {location.pathname !== "/" && (
          <div className="absolute left-3 sm:left-5">
            <BackButton hidden={false} inline={true} />
          </div>
        )}

        {/* Nav Links (centered) */}
        <div className="flex justify-center space-x-2 sm:space-x-4 text-white text-xs sm:text-sm md:text-[13px] font-medium">
          <Link
            to="/"
            className={`px-2 sm:px-4 py-1.5 rounded-full transition ${
              isActive("/") ? "bg-cyan-400 text-black" : "hover:text-cyan-400"
            }`}
          >
            Home
          </Link>
          <Link
            to="/benchmarks"
            className={`px-2 sm:px-4 py-1.5 rounded-full transition ${
              isActive("/benchmarks")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            Benchmarks
          </Link>
          <Link
            to="/morereviews"
            className={`px-2 sm:px-4 py-1.5 rounded-full transition ${
              isActive("/morereviews")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            More Reviews
          </Link>
          <Link
            to="/contact"
            className={`px-2 sm:px-4 py-1.5 rounded-full transition ${
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
