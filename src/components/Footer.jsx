import React from "react";
import { Link } from "react-router-dom";
export default function Footer() {
  return (
    <footer id="contact" className="py-16 mx-auto max-w-3xl px-6 text-center">
      <h2 className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight">
        {"Let's Talk About Your PC"}
      </h2>

      <p className="mt-3 text-sm text-slate-300/80">
        I'm always open to helping new clients optimize their systems.
      </p>

      <p className="mt-4 text-[15px] sm:text-base font-semibold text-[#19c5ff]">
        Whether it's gaming, work, or everyday use — let's get your PC running
        at its best.
      </p>

      <div className="mt-6">
        <Link
          to="/Contact"
          className="rounded-md bg-gradient-to-r from-sky-400 to-sky-600 px-5 py-3 text-sm font-semibold text-white 
             ring-1 ring-sky-700/50 hover:bg-sky-600/30 
             hover:shadow-[0_0_20px_rgba(56,189,248,0.7)] active:translate-y-px 
             transition-all duration-300"
        >
          Contact Me
        </Link>
      </div>

      <p className="mt-8 text-xs text-slate-400">
        Available for consultations • Let's chat
      </p>
      <a href="/privacy" className="mt-3 text-xs text-slate-400">
        Privacy and Policy
      </a>
      <a href="/terms" className="mt-3 text-xs text-slate-400">
        {" "}
        • Terms And Condition
      </a>
      <div className="h-3" />

      {/* Designed by Nerky */}
      <p className="mt-4 text-xs text-slate-400">
        Designed by{" "}
        <a
          href="https://discord.com/users/286457824081346570"
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan-400 hover:text-cyan-300 underline transition-colors"
        >
          Nerky
        </a>
      </p>
    </footer>
  );
}
