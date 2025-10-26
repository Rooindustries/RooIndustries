import React from "react";
import { FaDiscord, FaDownload, FaMicrochip, FaWindows } from "react-icons/fa";

export default function HowItWorks() {
  const steps = [
    {
      title: "Join our Discord",
      text: "Join our Discord and I will be in touch with you as soon as I see your booking.",
      icon: <FaDiscord className="w-6 h-6" />,
      badge: "Step 1",
    },
    {
      title: "Install a few apps",
      text: "You will be given a few apps to install (also mentioned in the FAQ). Install those and send me your “RustDesk ID”.",
      icon: <FaDownload className="w-6 h-6" />,
      badge: "Step 2",
    },
    {
      title: "BIOS & Overclocking",
      text: "I will start with optimizing your BIOS overclocking your RAM, then CPU and finally GPU.",
      icon: <FaMicrochip className="w-6 h-6" />,
      badge: "Step 3",
    },
    {
      title: "Game-Focused OS Tuning",
      text: "You tell me EXACTLY what games you play and what issues you have (if any) and I will tune your OS (Windows) accordingly.",
      icon: <FaWindows className="w-6 h-6" />,
      badge: "Step 4",
    },
  ];

  return (
    <section
      id="how-it-works"
      className="relative z-10  pb-24 px-6 text-white max-w-6xl mx-auto"
    >
      {/* Heading */}
      <h2 className="text-4xl sm:text-5xl font-extrabold text-center tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        How It Works
      </h2>
      <p className="mt-3 text-slate-150 text-center text-sm sm:text-base">
        A simple, battle-tested flow—fast communication, safe access, and
        laser-focused tuning.
      </p>

      {/* Steps */}
      <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-8">
        {steps.map((s, i) => (
          <div
            key={i}
            className="group backdrop-blur-sm bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl p-6
                       shadow-[0_0_25px_rgba(14,165,233,0.15)] hover:shadow-[0_0_35px_rgba(14,165,233,0.25)]
                       transition-all duration-300"
          >
            {/* Badge + Icon */}
            <div className="flex items-center justify-between">
              <span
                className="inline-flex items-center gap-2 text-xs font-semibold tracking-wide
                               text-sky-200/90 bg-sky-900/30 border border-sky-700/40 px-3 py-1 rounded-full
                               shadow-[0_0_12px_rgba(14,165,233,0.3)]"
              >
                {s.badge}
              </span>
              <div
                className="grid place-items-center w-11 h-11 rounded-xl border border-sky-700/40
                           bg-[#081225]/70 shadow-[0_0_18px_rgba(14,165,233,0.25)]"
              >
                {s.icon}
              </div>
            </div>

            {/* Content */}
            <h3 className="mt-4 text-xl font-bold text-white">{s.title}</h3>
            <p className="mt-2 text-slate-300/90 leading-relaxed">{s.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
