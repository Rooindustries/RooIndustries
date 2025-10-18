import React from "react";
import { Clock, Shield, Wrench, Zap, Video } from "lucide-react";

export default function Services() {
  return (
    <section className="mx-auto max-w-6xl pt-24">
      {/* Heading */}
      <div className="text-center">
        <h3 className="text-4xl sm:text-5xl font-extrabold tracking-tight">
          What I Do
        </h3>
        <p className="mt-2 text-slate-300/70 text-sm">
          Professional optimization services that deliver real results
        </p>
      </div>

      <div className="h-10" />

      {/* Top 4 service cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {/* Speed & Performance */}
        <div className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 hover:ring-[#19c5ff]/60 transition">
          <div className="mb-3">
            <Zap className="w-5 h-5 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
          </div>
          <h4 className="text-[15px] font-bold tracking-tight">
            Speed & Performance
          </h4>
          <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
            Eliminate lag, freezing, and slow boots. Your PC will feel faster,
            smoother, and more powerful than ever.
          </p>
          <div className="mt-5 border-t border-[#2b3a4a]" />
        </div>

        {/* Gaming Optimization */}
        <div className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 hover:ring-[#19c5ff]/60 transition">
          <div className="mb-3">
            <Clock className="text-cyan-400 w-5 h-5 drop-shadow-[0_0_6px_rgba(14,165,233,0.6)]" />
          </div>
          <h4 className="text-[15px] font-bold tracking-tight">
            Gaming Optimization
          </h4>
          <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
            Maximize FPS, reduce stutters, and achieve fluid, competitive-level
            gameplay across every title.
          </p>
          <div className="mt-5 border-t border-[#2b3a4a]" />
        </div>

        {/* System Reliability */}
        <div className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 hover:ring-[#19c5ff]/60 transition">
          <div className="mb-3">
            <Shield className="text-cyan-400 w-5 h-5 drop-shadow-[0_0_6px_rgba(14,165,233,0.6)]" />
          </div>
          <h4 className="text-[15px] font-bold tracking-tight">
            System Reliability
          </h4>
          <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
            Fix crashes, errors, and instability. Get a stable, clean system you
            can rely on every single day.
          </p>
          <div className="mt-5 border-t border-[#2b3a4a]" />
        </div>

        {/* Expert Troubleshooting */}
        <div className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 hover:ring-[#19c5ff]/60 transition">
          <div className="mb-3">
            <Wrench className="w-5 h-5 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
          </div>
          <h4 className="text-[15px] font-bold tracking-tight">
            Expert Troubleshooting
          </h4>
          <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
            From hidden issues to complex bugs, I track down problems others
            miss and bring your system back to perfection.
          </p>
          <div className="mt-5 border-t border-[#2b3a4a]" />
        </div>
      </div>

      {/* Streamers & Content Creators */}
      <div className="mt-6 flex justify-center">
        <div className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 w-full sm:w-[80%] md:w-[60%] hover:ring-[#19c5ff]/60 transition text-center">
          <div className="mb-3 flex justify-center">
            <Video className="w-6 h-6 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
          </div>
          <h4 className="text-[15px] font-bold tracking-tight">
            Streamers & Content Creators
          </h4>
          <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
            Tailored performance tuning for creators who demand flawless
            recording, editing, and live performance — all at once.
          </p>
          <div className="mt-5 border-t border-[#2b3a4a]" />
        </div>
      </div>

      <div className="h-3" />
    </section>
  );
}
