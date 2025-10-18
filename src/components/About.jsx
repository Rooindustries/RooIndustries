import React from "react";

export default function About() {
  return (
    <section id="about" className="mx-auto max-w-4xl pt-24 text-center">
      <h2 className="text-5xl sm:text-6xl font-extrabold tracking-tight">
        About Me
      </h2>

      <div className="mx-auto mt-6 max-w-2xl rounded-md bg-[#1b2430] p-6 ring-1 ring-[#2b3a4a] text-left text-[13px] leading-6 text-slate-200/90">
        I’ve spent years optimizing PCs and helping people unlock the full
        potential of their systems. Over 150+ satisfied customers have trusted
        me to fix their lag, boost performance, and solve issues that others
        couldn’t. I focus on what matters: speed, reliability, and peak
        performance. Every system is different, and I take pride in finding the
        right solution for each one. If your PC isn’t running at 100%, I’m here
        to help you get it to 110%.
      </div>

      <div className="mt-8 flex justify-center">
        <a
          href="https://www.3dmark.com/hall-of-fame-2/cpu+profile+16+threads+score/version+1.0"
          target="_blank"
        >
          <img
            src="/servitop.png"
            alt="System Benchmark Result"
            className="rounded-lg shadow-lg border border-[#2b3a4a] hover:border-cyan-500 transition-all duration-300"
          />
        </a>
      </div>

      {/* spacing to next section */}
      <div className="h-3" />
    </section>
  );
}
