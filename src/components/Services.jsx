import React, { useEffect, useMemo, useState } from "react";
import { client } from "../sanityClient";
import imageUrlBuilder from "@sanity/image-url";
import {
  Clock,
  Shield,
  Wrench,
  Zap,
  Video,
  Cpu,
  ChevronLeft,
  ChevronRight,
  HelpCircle,
} from "lucide-react";
import { AnimatePresence, motion, animate, useMotionValue } from "framer-motion";

const builder = imageUrlBuilder(client);
function urlFor(source) {
  return builder.image(source);
}

function AnimatedNumber({ value, duration = 0.65 }) {
  const mv = useMotionValue(0);
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const v = Number.isFinite(Number(value)) ? Number(value) : 0;
    setDisplay(0);
    mv.set(0);

    const controls = animate(mv, v, { duration, ease: "easeOut" });
    const unsub = mv.on("change", (latest) => setDisplay(Math.round(latest)));

    return () => {
      controls.stop();
      unsub();
    };
  }, [value, duration, mv]);

  return <span>{display}</span>;
}

export default function Services() {
  const [data, setData] = useState(null);
  const [benchPage, setBenchPage] = useState(0);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "services"][0]{
          heading,
          subheading,
          cards[]{ title, description, iconType, customIcon },
          benchMetricLabel,
          benchBadgeSuffix,
          benchBeforeLabel,
          benchAfterLabel,
          benchPagePrefix,
          benchPages[]{
            games[]{ gameTitle, beforeFps, afterFps, gpu, cpu, ram }
          }
        }`
      )
      .then(setData)
      .catch(console.error);
  }, []);

  const iconClass =
    "w-6 h-6 text-cyan-300 drop-shadow-[0_0_10px_rgba(56,189,248,0.35)]";

  const iconMap = useMemo(
    () => ({
      zap: Zap,
      clock: Clock,
      shield: Shield,
      wrench: Wrench,
      video: Video,
      cpu: Cpu,
    }),
    []
  );

  const cards = useMemo(() => data?.cards || [], [data]);

  const benchTotalPages = useMemo(
    () => (data?.benchPages?.length ? data.benchPages.length : 0),
    [data]
  );

  const safeBenchPage = useMemo(() => {
    if (!benchTotalPages) return 0;
    return Math.min(Math.max(benchPage, 0), benchTotalPages - 1);
  }, [benchPage, benchTotalPages]);

  useEffect(() => {
    if (benchPage !== safeBenchPage) setBenchPage(safeBenchPage);
  }, [benchPage, safeBenchPage]);

  const benchPageGames = useMemo(() => {
    if (!data?.benchPages?.length) return [];
    return data.benchPages[safeBenchPage]?.games || [];
  }, [data, safeBenchPage]);

  const benchGames3 = useMemo(() => {
    const arr = Array.isArray(benchPageGames)
      ? benchPageGames.slice(0, 3)
      : [];
    while (arr.length < 3) arr.push(null);
    return arr;
  }, [benchPageGames]);

  const canBenchPrev = safeBenchPage > 0;
  const canBenchNext = safeBenchPage < benchTotalPages - 1;

  const calcPct = (before, after) => {
    const b = Number(before || 0);
    const a = Number(after || 0);
    if (b <= 0 || a <= 0) return null;
    const pct = ((a - b) / b) * 100;
    if (!Number.isFinite(pct)) return null;
    return Math.round(pct);
  };

  const calcFill = (before, after) => {
    const b = Number(before || 0);
    const a = Number(after || 0);
    const m = Math.max(b, a, 1);
    return {
      bf: Math.max(0, Math.min(100, (b / m) * 100)),
      af: Math.max(0, Math.min(100, (a / m) * 100)),
    };
  };

  if (!data) return null;

  const beforeLabel = data.benchBeforeLabel || "Before";
  const afterLabel = data.benchAfterLabel || "Optimized";
  const pagePrefix = data.benchPagePrefix || "Page";
  const badgeSuffix = data.benchBadgeSuffix || "FPS";

  return (
    <section className="mx-auto max-w-[92rem] py-16 px-4 sm:px-6">
      <div className="text-center">
        {data.heading && (
          <h3 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-200">
            {data.heading}
          </h3>
        )}
        {data.subheading && (
          <p className="mt-2 text-slate-300/90 text-sm sm:text-[15px]">
            {data.subheading}
          </p>
        )}
      </div>

      <div className="h-10" />

      {/* SERVICE CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-5">
        {cards.map((card, i) => {
          const IconComponent = iconMap[card.iconType] || HelpCircle;

          return (
            <div
              key={i}
              className="group relative overflow-hidden rounded-2xl p-6 min-h-[190px]
                         bg-gradient-to-b from-[#111827]/70 to-[#0b1220]/85
                         ring-1 ring-white/10 shadow-[0_18px_55px_rgba(0,0,0,.55)]"
            >
              <div className="relative">
                <div className="w-14 h-14 rounded-2xl grid place-items-center bg-cyan-400/10 ring-1 ring-white/10">
                  {card.customIcon ? (
                    <img
                      src={urlFor(card.customIcon).width(64).url()}
                      alt={card.title}
                      className="w-7 h-7 object-contain"
                    />
                  ) : (
                    <IconComponent className={iconClass} />
                  )}
                </div>

                <h4 className="mt-5 text-[18px] font-extrabold text-white">
                  {card.title}
                </h4>

                <p className="mt-2 text-[13px] leading-5 text-slate-300/90">
                  {card.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* BENCHMARKS */}
      {benchTotalPages > 0 && (
        <>
          <div className="h-10" />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {benchGames3.map((g, idx) => {
              const pct = g ? calcPct(g.beforeFps, g.afterFps) : null;
              const { bf, af } = g
                ? calcFill(g.beforeFps, g.afterFps)
                : { bf: 0, af: 0 };

              return (
                <div
                  key={idx}
                  className="rounded-2xl bg-white/5 ring-1 ring-white/10 p-4"
                >
                  <div className="font-bold text-white">
                    {g?.gameTitle || "—"}
                  </div>

                  <div className="mt-2 text-sm text-slate-300">
                    {beforeLabel}:{" "}
                    {g ? <AnimatedNumber value={g.beforeFps} /> : "—"}
                  </div>

                  <div className="mt-1 text-sm text-cyan-300">
                    {afterLabel}:{" "}
                    {g ? <AnimatedNumber value={g.afterFps} /> : "—"}
                  </div>

                  <div className="mt-2 text-xs text-slate-400">
                    {pct !== null ? `+${pct}% ${badgeSuffix}` : "—"}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex justify-center items-center gap-3">
            <button
              onClick={() => canBenchPrev && setBenchPage((p) => p - 1)}
              disabled={!canBenchPrev}
            >
              <ChevronLeft />
            </button>

            <span className="text-sm text-slate-300">
              {pagePrefix} {safeBenchPage + 1} of {benchTotalPages}
            </span>

            <button
              onClick={() => canBenchNext && setBenchPage((p) => p + 1)}
              disabled={!canBenchNext}
            >
              <ChevronRight />
            </button>
          </div>
        </>
      )}
    </section>
  );
}
