import React, { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import BackButton from "./BackButton";

export default function Navbar() {
  const location = useLocation();
  const isActive = (path) => location.pathname === path;

  const [isVisible, setIsVisible] = useState(true);
  const [isPastLogo, setIsPastLogo] = useState(false);

  // Store last scroll value in a ref to avoid rerenders
  const lastScrollY = useRef(0);

  useEffect(() => {
    const handleScroll = () => {
      const currentY = window.scrollY;

      // Hide navbar when scrolling down, show when scrolling up
      if (currentY > lastScrollY.current && currentY > 50) {
        setIsVisible(false);
      } else {
        setIsVisible(true);
      }

      // Detect when user has scrolled past the hero logo area
      setIsPastLogo(currentY > 120);
      lastScrollY.current = currentY;
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const isHome = location.pathname === "/";

  return (
    <nav
      className={`
        w-full z-50 px-2 sm:px-8 transition-all duration-500 ease-in-out
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
      style={{ height: "0px" }} // This prevents layout shift from positioning changes
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
        {!isHome && (
          <div
            className="
              absolute left-3 top-1/2 -translate-y-1/2 
              scale-90 sm:scale-95 z-[60]
              w-[28px] sm:w-[32px] h-[28px] sm:h-[32px]
            "
          >
            <BackButton hidden={false} inline={true} />
          </div>
        )}

        {/* Nav Links */}
        <div
          className={`
            flex justify-center space-x-2 sm:space-x-4 
            text-white text-xs sm:text-sm md:text-[13px] font-medium
            transition-all duration-300

            ${
              !isHome
                ? "max-sm:translate-x-8" // Smooth balanced shift when BackButton shows
                : ""
            }
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
              isActive("/morereviews")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            Reviews
          </Link>

          <Link
            to="/packages"
            className={`px-2 sm:px-4 py-1.5 rounded-full transition ${
              isActive("/packages")
                ? "bg-cyan-400 text-black"
                : "hover:text-cyan-400"
            }`}
          >
            Book
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
