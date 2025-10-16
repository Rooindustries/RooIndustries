import React from "react";
import { Link } from "react-router-dom";

export default function Hero() {
  return (
    <header className="pt-24" id="top">
      <section className="mx-auto max-w-3xl px-6 text-center">
        <div
          className="inline-flex items-center rounded-full border border-slate-700/80 bg-slate-900/70 px-5 py-2
             shadow-[0_0_10px_rgba(0,255,255,0.6),0_0_20px_rgba(0,255,255,0.4)]"
        >
          <span className="text-sm font-medium text-slate-200">
            Servi – Professional PC Optimizer
          </span>
        </div>

        <h1 className="mt-8 text-4xl sm:text-5xl lg:text-6xl font-extrabold leading-tight tracking-tight">
          Get Your PC Running
        </h1>
        <div className="mt-1 text-4xl sm:text-5xl lg:text-6xl font-extrabold text-sky-400 leading-tight drop-shadow-[0_0_10px_rgba(56,189,248,0.7)]">
          Like New
        </div>

        <p className="mt-4 text-sm text-slate-300/80 leading-relaxed">
          I fix lag, boost gaming performance, and solve the issues other techs
          can't.
        </p>

        <p className="mt-6 font-semibold text-accent">
          150+ PCs optimized. 100% satisfaction.
        </p>

        <div className="mt-7 flex items-center justify-center gap-4">
          <a
            href="#reviews"
            className="rounded-md bg-sky-500 px-5 py-3 text-sm font-semibold text-white hover:bg-sky-400 hover:shadow-[0_0_20px_rgba(56,189,248,0.7)] active:translate-y-px transition-all duration-300"
          >
            View My Reviews →
          </a>
          <a
            href="https://mail.google.com/mail/?view=cm&to=serviroo@rooindustries.com"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md bg-sky-600/20 px-5 py-3 text-sm font-semibold text-white 
             ring-1 ring-sky-700/50 hover:bg-sky-600/30 
             hover:shadow-[0_0_20px_rgba(56,189,248,0.7)] active:translate-y-px 
             transition-all duration-300"
          >
            Contact Me
          </a>

          <Link
            to="/Benchmarks"
            className="rounded-md bg-sky-500 px-5 py-3 text-sm font-semibold text-white hover:bg-sky-400 hover:shadow-[0_0_20px_rgba(56,189,248,0.7)] active:translate-y-px transition-all duration-300"
          >
            View My Benchmarks →
          </Link>
        </div>

        {/* bullets */}
        <div className="mt-8 flex items-center justify-center gap-8 text-xs text-slate-300/90">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400"></span>
            <span>Same-Day Available</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400"></span>
            <span>Expert-Level Service</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400"></span>
            <span>150+ Happy Customers</span>
          </div>
        </div>
      </section>
      <div className="h-3" />
    </header>
  );
}
