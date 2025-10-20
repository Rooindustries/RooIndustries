import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { FaArrowLeft } from "react-icons/fa"; // arrow icon

export default function BackButton({ hidden, inline = false }) {
  const navigate = useNavigate();

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

  if (hidden) return null;

  return (
    <button
      onClick={() => navigate(-1)}
      aria-label="Go Back"
      className={`${inline ? "" : "fixed top-[80px] left-20"} 
        bg-cyan-500 hover:bg-cyan-400 text-black p-2 sm:p-3 rounded-full border border-cyan-400 
        transition-all duration-500 ease-in-out shadow-[0_0_15px_rgba(0,255,255,0.3)] 
        hover:shadow-[0_0_20px_rgba(0,255,255,0.5)] 
        z-40 hidden sm:flex items-center justify-center ${
          isVisible ? "translate-y-0 opacity-100" : "-translate-y-10 opacity-0"
        }`}
    >
      <FaArrowLeft className="text-lg sm:text-xl" />
    </button>
  );
}
