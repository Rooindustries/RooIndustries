import React from "react";
import { useNavigate } from "react-router-dom";
import { FaArrowLeft } from "react-icons/fa";
import { useScrollRuntime } from "../lib/scrollRuntime";

export default function BackButton({ hidden, inline = false }) {
  const navigate = useNavigate();
  const { scrollY, direction } = useScrollRuntime();

  if (hidden) return null;
  const isVisible = inline || !(direction === "down" && scrollY > 50);

  return (
    <button
      onClick={() => navigate(-1)}
      aria-label="Go Back"
      className={`${inline ? "" : "fixed top-[80px] left-20"}
        bg-accent hover:bg-accent-strong text-accent-contrast p-2 sm:p-3 rounded-full border border-line-accent
        transition-all duration-500 ease-in-out shadow-[var(--shadow-back-button)]
        hover:shadow-[var(--shadow-back-button-hover)]
        z-40 flex items-center justify-center
        ${isVisible ? "translate-y-0 opacity-100" : "-translate-y-10 opacity-0"}
        scale-90 active:scale-95
      `}
    >
      <FaArrowLeft className="text-base sm:text-lg" />
    </button>
  );
}
