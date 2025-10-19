import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function BackButton({ hidden }) {
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
      className={`fixed top-[80px] left-20 bg-cyan-600 border-2 border-cyan-500 text-black font-semibold py-2 px-5 rounded-md 
                 hover:bg-cyan-400 hover:border-cyan-400 transition-all duration-500 ease-in-out shadow-md hover:shadow-cyan-500/50 
                 z-40 hidden sm:block ${
                   isVisible
                     ? "translate-y-0 opacity-100"
                     : "-translate-y-20 opacity-0"
                 }`}
    >
      ← Back
    </button>
  );
}
