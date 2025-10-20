import React from "react";
import { Clock, Shield, Wrench, Zap, Video, Cpu } from "lucide-react";

export default function Services() {
  return (
    <section className="mx-auto max-w-6xl pt-24">
      {/* Heading */}
      <div className="text-center">
        <h3 className="text-4xl sm:text-5xl font-extrabold tracking-tight">
          What I Do
        </h3>
        <p className="mt-2 text-slate-300/70 text-sm">
          Real, hands-on PC optimization that makes a difference.
        </p>
      </div>

      <div className="h-10" />

      {/* Services Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {/* Speed & Performance */}
        <div className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 text-center hover:ring-[#19c5ff]/60 transition">
          <div className="mb-3 flex justify-center">
            <Zap className="w-5 h-5 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
          </div>
          <h4 className="text-[15px] font-bold tracking-tight">
            Speed & Performance
          </h4>
          <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
            I’ll fine-tune your system to run smoother and faster — cutting down
            on lag, freezing, and long boot times so everything feels
            effortless.
          </p>
          <div className="mt-5 border-t border-[#2b3a4a]" />
        </div>

        {/* Gaming Optimization */}
        <div className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 text-center hover:ring-[#19c5ff]/60 transition">
          <div className="mb-3 flex justify-center">
            <Clock className="text-cyan-400 w-5 h-5 drop-shadow-[0_0_6px_rgba(14,165,233,0.6)]" />
          </div>
          <h4 className="text-[15px] font-bold tracking-tight">
            Gaming Optimization
          </h4>
          <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
            Get the most out of your hardware. I’ll boost FPS, minimize
            stuttering, and make sure your games run as smooth and responsive as
            they should.
          </p>
          <div className="mt-5 border-t border-[#2b3a4a]" />
        </div>

        {/* System Reliability */}
        <div className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 text-center hover:ring-[#19c5ff]/60 transition">
          <div className="mb-3 flex justify-center">
            <Shield className="text-cyan-400 w-5 h-5 drop-shadow-[0_0_6px_rgba(14,165,233,0.6)]" />
          </div>
          <h4 className="text-[15px] font-bold tracking-tight">
            System Reliability
          </h4>
          <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
            I’ll clean up crashes, random errors, and weird issues that make
            your PC unstable — so you can rely on it to work every time.
          </p>
          <div className="mt-5 border-t border-[#2b3a4a]" />
        </div>

        {/* Expert Troubleshooting */}
        <div className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 text-center hover:ring-[#19c5ff]/60 transition">
          <div className="mb-3 flex justify-center">
            <Wrench className="w-5 h-5 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
          </div>
          <h4 className="text-[15px] font-bold tracking-tight">
            Expert Troubleshooting
          </h4>
          <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
            When something feels off and no one can figure it out — that’s where
            I come in. I find the root cause and fix it properly, not just patch
            it.
          </p>
          <div className="mt-5 border-t border-[#2b3a4a]" />
        </div>

        {/* Streamers & Content Creators */}
        <div className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 text-center hover:ring-[#19c5ff]/60 transition">
          <div className="mb-3 flex justify-center">
            <Video className="w-6 h-6 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
          </div>
          <h4 className="text-[15px] font-bold tracking-tight">
            Streamers & Content Creators
          </h4>
          <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
            Whether you’re streaming or editing, I’ll make sure your PC handles
            it all — smooth recordings, clean audio, zero frame drops.
          </p>
          <div className="mt-5 border-t border-[#2b3a4a]" />
        </div>

        {/* Workstation Efficiency */}
        <div className="rounded-md bg-[#121821] ring-1 ring-[#2b3a4a] p-6 text-center hover:ring-[#19c5ff]/60 transition">
          <div className="mb-3 flex justify-center">
            <Cpu className="w-6 h-6 text-cyan-400 drop-shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
          </div>
          <h4 className="text-[15px] font-bold tracking-tight">
            Workstation Efficiency
          </h4>
          <p className="mt-2 text-[12px] leading-5 text-slate-200/90">
            Built for productivity — I’ll optimize your setup for multitasking,
            heavy workloads, and a smoother daily workflow that keeps up with
            you.
          </p>
          <div className="mt-5 border-t border-[#2b3a4a]" />
        </div>
      </div>

      <div className="h-3" />
    </section>
  );
}
