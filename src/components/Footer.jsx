import React from "react";

export default function Footer() {
  return (
    <footer id="contact" className="py-16 mx-auto max-w-3xl px-6 text-center">
      <h2 className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight">
        Let's Talk About Your PC
      </h2>

      <p className="mt-3 text-sm text-slate-300/80">
        I'm always open to helping new clients optimize their systems.
      </p>

      <p className="mt-4 text-[15px] sm:text-base font-semibold text-[#19c5ff]">
        Whether it's gaming, work, or everyday use — let's get your PC running
        at its best.
      </p>

      <div className="mt-6">
        <a
          href="mailto:serviroo@rooindustries.com"
          className="rounded-md bg-sky-600/20 px-5 py-3 text-sm font-semibold text-sky-300 ring-1 ring-sky-700/50 hover:bg-sky-600/30 active:translate-y-px transition"
        >
          Contact Me
        </a>
      </div>

      <p className="mt-8 text-xs text-slate-400">
        Available for consultations • Let's chat
      </p>
      <div className="h-3" />
    </footer>
  );
}
