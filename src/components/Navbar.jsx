import React, { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import BackButton from "./BackButton";

export default function Navbar() {
  const location = useLocation();
  const isActive = (path) => location.pathname === path;

  const [isVisible, setIsVisible] = useState(true);
  const [lastScrollY, setLastScrollY] = useState(0);
  const [isPastLogo, setIsPastLogo] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;

      if (currentScrollY > lastScrollY && currentScrollY > 50) {
        setIsVisible(false);
      } else {
        setIsVisible(true);
      }

      // toggle when scrolled past logo
      setIsPastLogo(currentScrollY > 120);
      setLastScrollY(currentScrollY);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [lastScrollY]);

  useEffect(() => {
    if (location.hash === "#packages") {
      let retry;
      let attempts = 0;

      const scrollToPackages = () => {
        const el = document.getElementById("packages");
        if (el) {
          const rect = el.getBoundingClientRect();
          const elementTop = rect.top + window.scrollY; // Absolute position of the top of the element

          // --- FIX APPLIED HERE ---
          // Target Y is the absolute top position of the element.
          // This ensures the element's top aligns with the viewport's top.
          const targetY = elementTop; 
          
          // Ensure we don't scroll past the very top of the document (0)
          const finalScrollPosition = Math.max(0, targetY);

          window.scrollTo({
            top: finalScrollPosition,
            behavior: "smooth",
          });
          return;
        }
        if (attempts < 5) {
          attempts += 1;
          retry = setTimeout(scrollToPackages, 80);
        }
      };

      scrollToPackages();

      return () => {
        if (retry) clearTimeout(retry);
      };
    }
  }, [location]);

  return (
    <nav
      className={`
        site-nav
        w-full z-40 px-2 sm:px-8 transition-all duration-500 ease-in-out
        ${
          isVisible
            ? "translate-y-0 opacity-100"
            : "-translate-y-full opacity-0"
        }
        ${
          isPastLogo
            ? "fixed top-5"
            : "absolute top-[2.8rem] max-[639px]:top-[6.5rem] max-[479px]:top-[3rem]"
        }
      `}
    >
      <div
        className="
          relative mx-auto 
          max-w-md sm:max-w-3xl 
          md:max-w-[80%] xl:max-w-3xl
          flex items-center justify-center
          px-3 sm:px-6 md:px-4 py-2 sm:py-3 md:py-2
          rounded-full bg-[#0f172a]/80 backdrop-blur-md
          shadow-[0_0_25px_rgba(0,255,255,0.2)]
          border border-cyan-400/10 overflow-hidden
          transition-all duration-300
        "
      >
        {/* Back Button */}
        {location.pathname !== "/" && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 scale-90 sm:scale-95 z-[60]">
            <BackButton hidden={false} inline={true} />
          </div>
        )}

        {/* Nav Links */}
        <div
          className={`flex justify-center space-x-2 sm:space-x-4 text-white text-xs sm:text-sm md:text-[13px] font-medium transition-all duration-300
            ${location.pathname !== "/" ? "max-sm:translate-x-8" : ""}
          `}
        >
          <Link
            to="/faq"
            className={`hidden sm:inline px-2 sm:px-4 py-1.5 rounded-full transition ${
              isActive("/faq")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            FAQ
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
            to="/reviews"
            className={`px-2 sm:px-4 py-1.5 rounded-full transition ${
              isActive("/reviews")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            Reviews
          </Link>

          <Link
            to="/#packages"
            className="px-2 sm:px-4 py-1.5 rounded-full transition hover:text-cyan-400"
          >
            Plans
          </Link>
          <Link
            to="/tools"
            className={`px-2 sm:px-4 py-1.5 rounded-full transition max-[850px]:hidden ${
              isActive("/tools")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            Tools
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