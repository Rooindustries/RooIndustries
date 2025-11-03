import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Zap } from "lucide-react";
import { client } from "../sanityClient";

export default function Footer() {
  const [footerData, setFooterData] = useState(null);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "footer"][0]{
          title,
          subtitle,
          description,
          availability
        }`
      )
      .then(setFooterData)
      .catch(console.error);
  }, []);

  return (
    <footer
      id="contact"
      className="relative py-16 mx-auto max-w-3xl px-6 text-center text-white"
    >
      {/* Heading */}
      <h2 className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight drop-shadow-[0_0_10px_rgba(56,189,248,0.4)]">
        {footerData?.title || "Let's Talk About Your PC"}
      </h2>

      <p className="mt-3 text-sm text-slate-10">
        {footerData?.subtitle ||
          "I'm always open to helping new clients optimize their systems."}
      </p>

      <p className="mt-4 text-[15px] sm:text-base font-semibold text-white-300">
        {footerData?.description ||
          "Whether it's gaming, work, or everyday use — let's get your PC running at its best."}
      </p>

      {/* Buttons */}
      <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
        <Link
          to="/packages"
          className="inline-flex items-center justify-center gap-2 rounded-md bg-gradient-to-r from-sky-400 to-sky-600 
                       px-4 sm:px-5 py-3 text-sm font-semibold text-white 
                       ring-1 ring-sky-700/50 hover:from-cyan-400 hover:to-sky-500 
                       hover:shadow-[0_0_20px_rgba(56,189,248,0.6)] 
                       active:translate-y-px transition-all duration-300 w-full sm:w-auto"
        >
          <Zap className="w-4 h-4 sm:w-5 sm:h-5 text-white drop-shadow-[0_0_6px_rgba(56,189,248,0.8)]" />
          Supercharge Your Performance
        </Link>

        <Link
          to="/Contact"
          className="rounded-md bg-gradient-to-r from-sky-400 to-sky-600 
                     px-6 py-3 text-sm font-semibold text-white 
                     ring-1 ring-sky-700/50 hover:from-cyan-400 hover:to-sky-500 
                     hover:shadow-[0_0_20px_rgba(56,189,248,0.6)] 
                     active:translate-y-px transition-all duration-300 w-full sm:w-auto"
        >
          Contact Us
        </Link>
      </div>

      <p className="mt-8 text-xs text-white-400">
        {footerData?.availability || "Available for consultations • Let's chat"}
      </p>

      <div className="mt-3 space-x-1">
        <a
          href="/privacy"
          className="text-xs text-white-300 hover:text-cyan-300 transition"
        >
          Privacy and Policy
        </a>
        <span className="text-sky-400">•</span>
        <a
          href="/terms"
          className="text-xs text-white-300 hover:text-cyan-300 transition"
        >
          Terms And Conditions
        </a>
      </div>

      <div className="h-4" />

      {/* Credit */}
      <p className="mt-4 text-xs text-white-300">
        Designed by{" "}
        <a
          href="https://discord.com/users/286457824081346570"
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2 transition-colors"
        >
          Nerky
        </a>
      </p>
    </footer>
  );
}
