import React from "react";
import { Link } from "react-router-dom";

export default function Faq() {
  return (
    <section className="relative z-10 pt-32 pb-24 px-6 text-white max-w-5xl mx-auto">
      {/* Heading */}
      <h2 className="text-4xl sm:text-5xl font-extrabold text-center tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Frequently Asked Questions
      </h2>
      <p className="mt-3 text-slate-300/90 text-center text-sm sm:text-base">
        Everything you need to know before booking your optimization
      </p>

      <div className="mt-12 space-y-16">
        {/* SECTION 1 */}
        <div className="backdrop-blur-sm bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl shadow-[0_0_25px_rgba(14,165,233,0.15)] p-8">
          <h3 className="text-2xl font-bold text-sky-400 border-b border-sky-600/30 pb-2 mb-6">
            ⚙️ General & Experience
          </h3>

          <div className="space-y-6 text-slate-300 leading-relaxed">
            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                1) Why choose me?
              </h4>
              <p className="mt-1">
                As seen on the front page and reviews page, I have vast
                knowledge about PC hardware. I’ve worked with companies like
                Gigabyte and helped them test their products while also
                achieving a global spot for overclocking.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                2) Is this only for gamers?
              </h4>
              <p className="mt-1">
                No, this package is targeted towards every kind of user with
                either a Workstation (AMD Threadripper) or Desktop (Ryzen and
                Intel) chip. This will enhance productivity (render times,
                editing smoothing in timelines and so on) with both our
                packages!
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                3) Who does the optimizations?
              </h4>
              <p className="mt-1">
                Me (Serviroo) will be doing all your optimizations on my own as
                I believe that I can provide the best quality to my own clients.
                I like the hands-on experience rather than pawning off the work
                on somebody else.
              </p>
            </div>
          </div>
        </div>

        {/* SECTION 2 */}
        <div className="backdrop-blur-sm bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl shadow-[0_0_25px_rgba(14,165,233,0.15)] p-8">
          <h3 className="text-2xl font-bold text-sky-400 border-b border-sky-600/30 pb-2 mb-6">
            ⚡ Performance & Results
          </h3>
          <div className="space-y-6 text-slate-300 leading-relaxed">
            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                4) What are expected results?
              </h4>
              <p className="mt-1">
                You can expect a good performance boost up to 92%. On average my
                clients get around 25–40% boosts in their performance and most
                importantly, 40–50% latency reduction.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                5) Will this optimization improve my skills?
              </h4>
              <p className="mt-1">
                Frankly speaking, getting optimized can change how your
                mechanics feel. This can be good or bad depending on how you
                adjust. It helps you feel more consistent but does not improve
                skill by itself — practice is still key.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                6) Which games does your optimization work on?
              </h4>
              <p className="mt-1">
                Optimizations work system-wide for latency. FPS gains vary
                depending on the title — newer poorly optimized games may have
                similar averages but much better 1% lows and frame consistency.
              </p>
            </div>
          </div>
        </div>

        {/* SECTION 3 */}
        <div className="backdrop-blur-sm bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl shadow-[0_0_25px_rgba(14,165,233,0.15)] p-8">
          <h3 className="text-2xl font-bold text-sky-400 border-b border-sky-600/30 pb-2 mb-6">
            💸 Plans, Refunds & Warranties
          </h3>
          <div className="space-y-6 text-slate-300 leading-relaxed">
            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                7) Do you offer refunds? What is the warranty?
              </h4>
              <p className="mt-1">
                I offer a 3-day refund window in case no measurable improvement
                is achieved. Standard Performance Boost includes a 30-day
                warranty, while XOC has a lifetime warranty with 24–48h
                turnaround. Even after that, I’ll help guide you — no man left
                behind.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                8) Why is XOC not readily purchasable?
              </h4>
              <p className="mt-1">
                XOC is a highly specialized plan which requires you to be on the
                AM5 platform with the right RAM and motherboard combination. It
                ensures your hardware can actually benefit before purchase.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                9) What does “Upgrade PC each 6 months and get reXOC’d for free”
                mean?
              </h4>
              <p className="mt-1">
                If you upgrade your CPU, RAM, or motherboard within 6 months,
                you can get one free reXOC under the terms. Buy once and never
                again — lifetime support.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                10) What if I want to change a part before the 6-month period?
              </h4>
              <p className="mt-1">
                No problem at all — a one-time $50 fee applies for a reXOC
                outside the 6-month window.
              </p>
            </div>
          </div>
        </div>

        {/* SECTION 4 */}
        <div className="backdrop-blur-sm bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl shadow-[0_0_25px_rgba(14,165,233,0.15)] p-8">
          <h3 className="text-2xl font-bold text-sky-400 border-b border-sky-600/30 pb-2 mb-6">
            🧠 Technical Details & Process
          </h3>
          <div className="space-y-6 text-slate-300 leading-relaxed">
            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                11) Do I have to know how computers work?
              </h4>
              <p className="mt-1">
                Although knowledge helps, I guide and teach you through the
                whole process. You’ll understand how it works and can reproduce
                it in the future.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                12) What if my BIOS gets reset?
              </h4>
              <p className="mt-1">
                You’ll be provided with all major settings and instructions to
                save a profile. If you ever lose them, you can restore them
                easily with my guidance.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                13) Can’t I just do this myself?
              </h4>
              <p className="mt-1">
                Yes, but it took me over 9 months to learn and a year to
                perfect. This service is for people who want guaranteed, fast
                results with support and warranty.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                14) How long does the session take?
              </h4>
              <p className="mt-1">
                The Standard Performance Boost takes around 3–4 hours with full
                testing. XOC can take 3–4 days for proper stress testing and
                tuning — but you can still use your PC during it.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                15) What software do you use? Is it trusted?
              </h4>
              <p className="mt-1">
                I use RustDesk for remote control, ZenTimings for memory timing
                view, ASRock Timing Control, 3DMark, and BenchMate for
                benchmarking. All are trusted tools in the overclocking
                community.
              </p>
            </div>
          </div>
        </div>

        {/* SECTION 5 */}
        <div className="backdrop-blur-sm bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl shadow-[0_0_25px_rgba(14,165,233,0.15)] p-8">
          <h3 className="text-2xl font-bold text-sky-400 border-b border-sky-600/30 pb-2 mb-6">
            🧩 Compatibility & Benchmarks
          </h3>
          <div className="space-y-6 text-slate-300 leading-relaxed">
            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                16) What kind of hardware is not supported?
              </h4>
              <p className="mt-1">
                Currently I do not work with laptops or Intel locked CPUs (F
                series for example). I plan to support these in the future once
                I can ensure equal value and results.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                17) Why synthetic benchmarks and not CapFrameX or LatencyMon?
              </h4>
              <p className="mt-1">
                CapFrameX and LatencyMon can sometimes produce inconsistent
                readings. Synthetic benchmarks give a reliable baseline of
                improvement that’s measurable and repeatable.
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                18) Why are OS optimizations limited?
              </h4>
              <p className="mt-1">
                Any custom OS with small fine-tuned tweaks is more than enough.
                Usually, the bottleneck is your hardware. There are benchmarks
                on my site to prove that!
              </p>
            </div>

            <div>
              <h4 className="text-lg font-semibold text-sky-100">
                19) Why is my process count still high?
              </h4>
              <p className="mt-1">
                Process count has minimal impact on real performance. Still, I
                can manually debloat your system or guide you toward a clean
                custom OS if that’s your goal.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="mt-16 flex justify-center">
        <Link
          to="/packages"
          className="rounded-md bg-gradient-to-r from-sky-400 to-blue-600 
                               px-3 sm:px-5 py-2 sm:py-3 text-[11px] sm:text-sm font-semibold text-white 
                               ring-1 ring-sky-700/50 hover:from-cyan-400 hover:to-sky-500 
                               hover:shadow-[0_0_20px_rgba(56,189,248,0.6)] 
                               active:translate-y-px transition-all duration-300"
        >
          Supercharge Your Performance Now
        </Link>
      </div>
    </section>
  );
}
