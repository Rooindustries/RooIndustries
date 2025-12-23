import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { FaArrowLeft } from "react-icons/fa";

export default function BackButton({ hidden, inline = false }) {
  const navigate = useNavigate();

  const [isVisible, setIsVisible] = useState(true);
  const lastScrollYRef = useRef(0);

  useEffect(() => {
    if (hidden || inline) {
      setIsVisible(true);
      return;
    }

    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      if (currentScrollY > lastScrollYRef.current && currentScrollY > 50) {
        setIsVisible(false);
      } else {
        setIsVisible(true);
      }
      lastScrollYRef.current = currentScrollY;
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [hidden, inline]);

  if (hidden) return null;

  return (
    <button
      onClick={() => navigate(-1)}
      aria-label="Go Back"
      className={`${inline ? "" : "fixed top-[80px] left-20"} 
        bg-cyan-500 hover:bg-cyan-400 text-black p-2 sm:p-3 rounded-full border border-cyan-400 
        transition-all duration-500 ease-in-out shadow-[0_0_15px_rgba(0,255,255,0.3)] 
        hover:shadow-[0_0_20px_rgba(0,255,255,0.5)] 
        z-40 flex items-center justify-center
        ${isVisible ? "translate-y-0 opacity-100" : "-translate-y-10 opacity-0"}
        scale-90 active:scale-95
      `}
    >
      <FaArrowLeft className="text-base sm:text-lg" />
    </button>
  );
}
