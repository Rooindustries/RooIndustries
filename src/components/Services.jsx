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
import {
  AnimatePresence,
  motion,
  animate,
  useMotionValue,
} from "framer-motion";

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
  const [page, setPage] = useState(0);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "services"][0]{
          heading,
          subheading,
          cards[]{title, description, iconType, customIcon},
          benchEnabled,
          benchBeforeLabel,
          benchAfterLabel,
          benchPagePrefix,
          benchPages[]{
            games[]{gameTitle, gameLogo, beforeFps, afterFps, gpu, cpu, ram}
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

  const totalPages = useMemo(
    () => (data?.benchPages?.length ? data.benchPages.length : 0),
    [data]
  );

  const safePage = useMemo(() => {
    if (!totalPages) return 0;
    return Math.min(Math.max(page, 0), totalPages - 1);
  }, [page, totalPages]);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const pageGames = useMemo(() => {
    if (!data?.benchPages?.length) return [];
    return data.benchPages[safePage]?.games || [];
  }, [data, safePage]);

  const benchShouldRender = useMemo(() => {
    const enabled = data?.benchEnabled !== false;
    return enabled && totalPages > 0;
  }, [data, totalPages]);

  // 1. GRID COLUMNS logic
  const gridClass = useMemo(() => {
    const count = pageGames.length;
    if (count === 1) return "grid grid-cols-1 gap-5";
    if (count === 2) return "grid grid-cols-1 md:grid-cols-2 gap-5";
    return "grid grid-cols-1 md:grid-cols-3 gap-5";
  }, [pageGames.length]);

  const containerClass = useMemo(() => {
    const count = pageGames.length;
    if (count === 1) return "max-w-xl";
    if (count === 2) return "max-w-5xl";
    return "w-full";
  }, [pageGames.length]);

  const canPrev = safePage > 0;
  const canNext = safePage < totalPages - 1;

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
    const bf = Math.max(0, Math.min(100, (b / m) * 100));
    const af = Math.max(0, Math.min(100, (a / m) * 100));
    return { bf, af };
  };

  const iconWrap =
    "w-14 h-14 rounded-2xl grid place-items-center relative " +
    "bg-gradient-to-b from-sky-400/15 via-cyan-400/10 to-transparent " +
    "ring-1 ring-white/10 shadow-[0_10px_30px_rgba(0,0,0,.45)] " +
    "after:content-[''] after:absolute after:inset-0 after:rounded-2xl " +
    "after:bg-[radial-gradient(60%_60%_at_50%_20%,rgba(56,189,248,.25),transparent_70%)] " +
    "after:opacity-70";

  const contentSwap = {
    initial: { opacity: 0, scale: 0.98 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.98 },
    transition: { duration: 0.25, ease: "easeOut" },
  };

  if (!data) return null;

  const beforeLabel = data.benchBeforeLabel || "Before";
  const afterLabel = data.benchAfterLabel || "Optimized";
  const pagePrefix = data.benchPagePrefix || "Page";

  return (
    <section className="mx-auto max-w-[92rem] py-16 px-4 sm:px-6">
      <div className="text-center">
        {data.heading && (
          <h3 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.45)]">
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
        {data.cards?.map((card, i) => {
          const IconComponent = iconMap[card.iconType] || HelpCircle;

          return (
            <div
              key={i}
              className={
                "group relative overflow-hidden rounded-2xl p-6 min-h-[190px] " +
                "bg-gradient-to-b from-[#111827]/70 to-[#0b1220]/85 " +
                "ring-1 ring-white/10 shadow-[0_18px_55px_rgba(0,0,0,.55)] " +
                "transition duration-300 hover:-translate-y-[2px] hover:ring-cyan-400/35"
              }
            >
              <div className="pointer-events-none absolute inset-0 opacity-70">
                <div className="absolute -top-24 -left-24 h-56 w-56 rounded-full bg-cyan-400/10 blur-3xl" />
                <div className="absolute -bottom-24 -right-24 h-56 w-56 rounded-full bg-sky-400/10 blur-3xl" />
              </div>

              <div className="relative">
                <div className={iconWrap}>
                  {/* SEO: keep custom service icons as img elements with descriptive alt text. */}
                  {card.customIcon ? (
                    <img
                      src={urlFor(card.customIcon).width(64).url()}
                      alt={card.title ? `${card.title} service icon` : "Service icon"}
                      width={28}
                      height={28}
                      loading="lazy"
                      decoding="async"
                      className="w-7 h-7 object-contain drop-shadow-[0_0_8px_rgba(56,189,248,0.25)]"
                    />
                  ) : (
                    <IconComponent className={iconClass} />
                  )}
                </div>

                <h4 className="mt-5 text-[18px] font-extrabold tracking-tight text-white">
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

      {benchShouldRender && (
        <>
          <div className="h-10" />

          {/* CONTAINER BOX */}
          <motion.div
            layout
            className={`relative rounded-[28px] ring-1 ring-white/10 bg-gradient-to-b from-[#0d1526]/70 to-[#070c15]/85 shadow-[0_32px_110px_rgba(0,0,0,.7)] overflow-hidden mx-auto ${containerClass}`}
          >
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute inset-0 opacity-[0.35] bg-[radial-gradient(80%_60%_at_50%_0%,rgba(56,189,248,.18),transparent_65%)]" />
              <div className="absolute inset-0 opacity-[0.28] bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,.22))]" />
              <div className="absolute -top-56 left-1/2 -translate-x-1/2 h-[32rem] w-[52rem] rounded-full bg-white/5 blur-3xl" />
              <div className="absolute -bottom-48 left-0 h-[30rem] w-[30rem] rounded-full bg-cyan-400/10 blur-3xl" />
              <div className="absolute -bottom-48 right-0 h-[30rem] w-[30rem] rounded-full bg-sky-400/10 blur-3xl" />
            </div>

            <div className="relative p-5 sm:p-6">
              <div className={gridClass}>
                {pageGames.map((g, idx) => {
                  const pct = g ? calcPct(g?.beforeFps, g?.afterFps) : null;
                  const { bf, af } = g
                    ? calcFill(g?.beforeFps, g?.afterFps)
                    : { bf: 0, af: 0 };

                  const beforeNum =
                    g && Number.isFinite(Number(g?.beforeFps))
                      ? Number(g.beforeFps)
                      : null;

                  const afterNum =
                    g && Number.isFinite(Number(g?.afterFps))
                      ? Number(g.afterFps)
                      : null;

                  return (
                    <motion.div
                      layout
                      key={idx}
                      className={
                        "relative overflow-hidden rounded-2xl " +
                        "bg-gradient-to-b from-white/6 to-white/[0.015] " +
                        "ring-1 ring-white/10 shadow-[0_18px_60px_rgba(0,0,0,.55)]"
                      }
                    >
                      <div className="pointer-events-none absolute inset-0">
                        <div className="absolute -top-16 -right-16 h-44 w-44 rounded-full bg-cyan-400/10 blur-2xl" />
                        <div className="absolute -bottom-16 -left-16 h-44 w-44 rounded-full bg-sky-400/8 blur-2xl" />
                        <div className="absolute left-0 top-0 h-full w-[3px] bg-gradient-to-b from-cyan-300/70 via-sky-300/30 to-transparent opacity-60" />
                      </div>

                      <div className="relative p-5">
                        <AnimatePresence mode="wait">
                          <motion.div
                            key={`${safePage}-${idx}`}
                            initial={contentSwap.initial}
                            animate={contentSwap.animate}
                            exit={contentSwap.exit}
                            transition={contentSwap.transition}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  {g?.gameLogo ? (
                                    <img
                                      src={urlFor(g.gameLogo)
                                        .width(64)
                                        .height(64)
                                        .fit("max")
                                        .url()}
                                      alt={g?.gameTitle ? `${g.gameTitle} logo` : "Game logo"}
                                      width={24}
                                      height={24}
                                      loading="lazy"
                                      decoding="async"
                                      className="h-5 w-5 sm:h-6 sm:w-6 shrink-0 rounded-sm object-contain"
                                    />
                                  ) : null}
                                  <div className="truncate text-[16px] sm:text-[17px] font-extrabold tracking-tight text-white">
                                    {g?.gameTitle || "-"}
                                  </div>
                                </div>
                                <div className="mt-1 h-[2px] w-14 rounded-full bg-gradient-to-r from-cyan-300/70 to-transparent opacity-70" />
                              </div>

                              <span
                                className={
                                  "inline-flex items-center rounded-full px-3 py-1 text-[12px] font-extrabold " +
                                  "bg-white/5 text-cyan-100 ring-1 ring-cyan-300/25 " +
                                  "shadow-[0_10px_30px_rgba(0,0,0,.35)]"
                                }
                              >
                                {pct === null ? "—" : `+${pct}% FPS`}
                              </span>
                            </div>

                            <div className="mt-4 rounded-2xl bg-black/25 ring-1 ring-white/10 p-3">
                              <div className="space-y-3">
                                <div>
                                  <div className="flex items-center justify-between text-[12px]">
                                    <span className="text-slate-300/80">
                                      {beforeLabel}
                                    </span>
                                    <span className="font-extrabold text-white">
                                      {beforeNum === null ? (
                                        "—"
                                      ) : (
                                        <AnimatedNumber value={beforeNum} />
                                      )}
                                    </span>
                                  </div>

                                  <div className="mt-2 h-[10px] rounded-full bg-white/10 ring-1 ring-white/10 overflow-hidden">
                                    <motion.div
                                      className="h-full rounded-full bg-gradient-to-r from-white/30 via-white/15 to-transparent"
                                      initial={{ width: 0 }}
                                      animate={{
                                        width: `${beforeNum ? bf : 0}%`,
                                      }}
                                      transition={{
                                        duration: 0.8,
                                        ease: "easeOut",
                                      }}
                                    />
                                  </div>
                                </div>

                                <div>
                                  <div className="flex items-center justify-between text-[12px]">
                                    <span className="text-cyan-100/80">
                                      {afterLabel}
                                    </span>
                                    <span className="font-extrabold text-white">
                                      {afterNum === null ? (
                                        "—"
                                      ) : (
                                        <AnimatedNumber value={afterNum} />
                                      )}
                                    </span>
                                  </div>

                                  <div className="mt-2 h-[10px] rounded-full bg-cyan-400/10 ring-1 ring-cyan-300/20 overflow-hidden">
                                    <motion.div
                                      className="h-full rounded-full bg-[linear-gradient(90deg,rgba(56,189,248,.55),rgba(125,211,252,.22),transparent)]"
                                      initial={{ width: 0 }}
                                      animate={{
                                        width: `${afterNum ? af : 0}%`,
                                      }}
                                      transition={{
                                        duration: 0.8,
                                        ease: "easeOut",
                                      }}
                                    />
                                  </div>
                                </div>
                              </div>

                              <div className="mt-3 flex items-center gap-5 text-[12px] text-slate-300/80">
                                <div className="flex items-center gap-2">
                                  <span className="h-2 w-2 rounded-full bg-white/60" />
                                  <span>{beforeLabel}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="h-2 w-2 rounded-full bg-cyan-300/80 shadow-[0_0_14px_rgba(56,189,248,.28)]" />
                                  <span>{afterLabel}</span>
                                </div>
                              </div>
                            </div>

                            <div className="mt-4 rounded-xl bg-black/40 ring-1 ring-white/5 p-3">
                              <div className="grid grid-cols-3 gap-2 divide-x divide-white/10 text-center">
                                <div className="flex flex-col px-1">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                                    GPU
                                  </span>
                                  <span className="text-[11px] font-medium text-slate-300 leading-tight break-words">
                                    {g?.gpu || "—"}
                                  </span>
                                </div>
                                <div className="flex flex-col px-1">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                                    CPU
                                  </span>
                                  <span className="text-[11px] font-medium text-slate-300 leading-tight break-words">
                                    {g?.cpu || "—"}
                                  </span>
                                </div>
                                <div className="flex flex-col px-1">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                                    RAM
                                  </span>
                                  <span className="text-[11px] font-medium text-slate-300 leading-tight break-words">
                                    {g?.ram || "—"}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        </AnimatePresence>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          </motion.div>

          <div className="mt-4 flex items-center justify-center">
            <div className="inline-flex items-center gap-3 rounded-full bg-white/5 ring-1 ring-white/10 px-3 py-2 shadow-[0_14px_45px_rgba(0,0,0,.55)]">
              <button
                type="button"
                onClick={() => canPrev && setPage((p) => Math.max(0, p - 1))}
                disabled={!canPrev}
                className={
                  "h-9 w-9 rounded-full grid place-items-center " +
                  "bg-black/20 ring-1 ring-white/10 " +
                  "transition hover:bg-white/10 active:scale-95 " +
                  (canPrev ? "" : "opacity-40 cursor-not-allowed")
                }
                aria-label="Previous page"
              >
                <ChevronLeft className="h-5 w-5 text-slate-200" />
              </button>

              <div className="min-w-[92px] text-center text-[13px] font-extrabold text-slate-200/90">
                {pagePrefix} {safePage + 1}
              </div>

              <button
                type="button"
                onClick={() =>
                  canNext && setPage((p) => Math.min(totalPages - 1, p + 1))
                }
                disabled={!canNext}
                className={
                  "h-9 w-9 rounded-full grid place-items-center " +
                  "bg-black/20 ring-1 ring-white/10 " +
                  "transition hover:bg-white/10 active:scale-95 " +
                  (canNext ? "" : "opacity-40 cursor-not-allowed")
                }
                aria-label="Next page"
              >
                <ChevronRight className="h-5 w-5 text-slate-200" />
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
