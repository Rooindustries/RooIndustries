import React, { useEffect, useMemo, useState } from "react";
import { urlFor } from "../sanityClient";
import homeCopy from "../lib/homeCopy";
import { fetchHomeSectionData, HOME_SECTION_DATA_KEYS } from "../lib/homeSectionData";
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

const { HOME_COPY } = homeCopy;
const CANONICAL_SERVICE_CARDS = HOME_COPY.services.cards;

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

export default function Services({ initialData = null }) {
  const [data, setData] = useState(() => initialData);

  useEffect(() => {
    if (initialData !== null) {
      setData(initialData);
    }
  }, [initialData]);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (data !== null) return;
    fetchHomeSectionData(HOME_SECTION_DATA_KEYS.services)
      .then(setData)
      .catch(console.error);
  }, [data]);

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

  const contentSwap = {
    initial: { opacity: 0, scale: 0.98 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.98 },
    transition: { duration: 0.25, ease: "easeOut" },
  };

  if (!data) {
    return (
      <section className="mx-auto max-w-[92rem] py-16 px-4 sm:px-6" aria-hidden="true">
        <div className="ri-services-skeleton min-h-[980px] rounded-3xl border border-line-input bg-skeleton" />
      </section>
    );
  }

  const beforeLabel = data.benchBeforeLabel || "Before";
  const afterLabel = data.benchAfterLabel || "After Tune";
  const badgeSuffix = data.benchBadgeSuffix || "FPS";
  const pagePrefix = data.benchPagePrefix || "Page";

  const cards = data.cards?.length ? data.cards : CANONICAL_SERVICE_CARDS;

  return (
    <section className="mx-auto max-w-[92rem] pt-8 pb-16 px-4 sm:px-6">
      <div className="text-center">
        {data.heading && (
          <h3 className="ri-services-heading text-4xl sm:text-5xl font-bold tracking-tight text-info-text">
            {data.heading}
          </h3>
        )}
        {data.subheading && (
          <p className="ri-services-subheading mt-2 text-ink-secondary text-sm sm:text-[15px]">
            {data.subheading}
          </p>
        )}
      </div>

      <div className="h-10" />

      {/* SERVICE CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {cards.map((card, i) => {
          const canonical = CANONICAL_SERVICE_CARDS[i];
          const title = canonical?.title ?? card.title;
          const desc = canonical?.description ?? card.description;
          const Icon = iconMap[canonical?.iconType ?? card.iconType] || HelpCircle;
          return (
            <motion.div
              key={card._key || `svc-${i}`}
              className="ri-service-card rounded-2xl border border-line-input bg-panel p-6 min-h-[220px]"
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.35, delay: i * 0.04, ease: "easeOut" }}
            >
              <div className="ri-service-icon-shell w-12 h-12 rounded-xl grid place-items-center bg-surface-input border border-line-input">
                {card.customIcon ? (
                  <img
                    src={urlFor(card.customIcon).width(64).url()}
                    alt={title ? `${title} icon` : "Service icon"}
                    width={22}
                    height={22}
                    loading="lazy"
                    decoding="async"
                    className="w-[22px] h-[22px] object-contain"
                  />
                ) : (
                  <Icon className="ri-service-icon w-[22px] h-[22px] text-accent" />
                )}
              </div>
              <h4 className="ri-service-title text-[21px] font-semibold tracking-[-0.01em] text-ink mt-5">
                {title}
              </h4>
              <p className="ri-service-copy mt-3 text-[16px] leading-relaxed text-ink-secondary">
                {desc}
              </p>
            </motion.div>
          );
        })}
      </div>

      {benchShouldRender && (
        <>
          <div className="h-10" />

          {/* CONTAINER BOX */}
          <motion.div
            layout
            className={`ri-bench-shell relative rounded-[28px] ring-1 ring-line-soft bg-panel shadow-surface-deep overflow-hidden mx-auto ${containerClass}`}
          >
            <div className="pointer-events-none absolute inset-0">
              <div className="ri-bench-radial absolute inset-0 opacity-[0.35] bg-[radial-gradient(80%_60%_at_50%_0%,var(--color-surface-hover-accent),transparent_65%)]" />
              <div className="absolute inset-0 opacity-[0.28] bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,.22))]" />
              <div className="ri-bench-top-glow absolute -top-56 left-1/2 -translate-x-1/2 h-[32rem] w-[52rem] rounded-full bg-surface-hover blur-3xl hidden sm:block" />
              <div className="ri-bench-left-glow absolute -bottom-48 left-0 h-[30rem] w-[30rem] rounded-full bg-surface-hover-accent blur-3xl hidden sm:block" />
              <div className="ri-bench-right-glow absolute -bottom-48 right-0 h-[30rem] w-[30rem] rounded-full bg-surface-hover-accent blur-3xl hidden sm:block" />
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

                  const metricText =
                    g?.metricLabel || data?.benchMetricLabel || "Avg FPS";

                  return (
                    <motion.div
                      layout
                      key={idx}
                      className={
                        "ri-bench-card relative overflow-hidden rounded-2xl " +
                        "bg-surface-card ring-1 ring-line-soft shadow-surface-deep"
                      }
                    >
                      <div className="pointer-events-none absolute inset-0">
                        <div className="ri-bench-card-top-glow absolute -top-16 -right-16 h-44 w-44 rounded-full bg-surface-hover-accent blur-2xl hidden sm:block" />
                        <div className="ri-bench-card-bottom-glow absolute -bottom-16 -left-16 h-44 w-44 rounded-full bg-surface-hover-accent blur-2xl hidden sm:block" />
                        <div className="ri-bench-card-rail absolute left-0 top-0 h-full w-[3px] bg-gradient-to-b from-accent via-accent-soft to-transparent opacity-60" />
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
                                      alt={
                                        g?.gameTitle
                                          ? `${g.gameTitle} logo`
                                          : "Game logo"
                                      }
                                      width={24}
                                      height={24}
                                      loading="lazy"
                                      decoding="async"
                                      className="h-5 w-5 sm:h-6 sm:w-6 shrink-0 rounded-sm object-contain"
                                    />
                                  ) : null}
                                  <div className="ri-bench-game-title truncate text-[16px] sm:text-[17px] font-extrabold tracking-tight text-ink">
                                    {g?.gameTitle || "-"}
                                  </div>
                                </div>
                                <div className="ri-bench-game-rule mt-1 h-[2px] w-14 rounded-full bg-gradient-to-r from-accent to-transparent opacity-70" />
                                {metricText ? (
                                  <div className="mt-3">
                                    <span
                                      className={
                                        "ri-bench-metric-pill inline-flex items-center rounded-full px-2.5 py-1 text-[13px] font-semibold " +
                                        "bg-surface-hover text-ink-secondary ring-1 ring-line-soft " +
                                        "shadow-[0_8px_22px_rgba(0,0,0,.3)]"
                                      }
                                    >
                                      {metricText}
                                    </span>
                                  </div>
                                ) : null}
                              </div>

                              <span
                                className={
                                  "ri-bench-boost-pill inline-flex items-center rounded-full px-3 py-1 text-[12px] font-extrabold " +
                                  "bg-surface-hover-accent text-accent ring-1 ring-line-accent shadow-glow-soft"
                                }
                              >
                                {pct === null ? "-" : `+${pct}% ${badgeSuffix}`}
                              </span>
                            </div>

                            <div className="ri-bench-bars mt-4 rounded-2xl bg-surface-input ring-1 ring-line-input p-3">
                              <div className="space-y-3">
                                <div>
                                  <div className="flex items-center justify-between text-[12px]">
                                    <span className="ri-bench-before-label text-ink-secondary">
                                      {beforeLabel}
                                    </span>
                                    <span className="ri-bench-number font-extrabold text-ink">
                                      {beforeNum === null ? (
                                        "-"
                                      ) : (
                                        <AnimatedNumber value={beforeNum} />
                                      )}
                                    </span>
                                  </div>

                                  <div className="ri-bench-before-track mt-2 h-[10px] rounded-full bg-surface-hover ring-1 ring-line-soft overflow-hidden">
                                    <motion.div
                                      className="ri-bench-before-fill h-full rounded-full bg-gradient-to-r from-ink-muted via-line-soft to-transparent"
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
                                    <span className="ri-bench-after-label text-accent">
                                      {afterLabel}
                                    </span>
                                    <span className="ri-bench-number font-extrabold text-ink">
                                      {afterNum === null ? (
                                        "-"
                                      ) : (
                                        <AnimatedNumber value={afterNum} />
                                      )}
                                    </span>
                                  </div>

                                  <div className="ri-bench-after-track mt-2 h-[10px] rounded-full bg-surface-hover-accent ring-1 ring-line-accent overflow-hidden">
                                    <motion.div
                                      className="ri-bench-after-fill h-full rounded-full bg-gradient-to-r from-accent via-accent-soft to-transparent"
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

                              <div className="ri-bench-legend mt-3 flex items-center gap-5 text-[12px] text-ink-secondary">
                                <div className="flex items-center gap-2">
                                  <span className="ri-bench-before-dot h-2 w-2 rounded-full bg-ink-muted" />
                                  <span>{beforeLabel}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="ri-bench-after-dot h-2 w-2 rounded-full bg-accent shadow-glow-soft" />
                                  <span>{afterLabel}</span>
                                </div>
                              </div>
                            </div>

                            <div className="ri-bench-hardware mt-4 rounded-xl bg-surface-veil ring-1 ring-line-soft p-3">
                              <div className="ri-bench-hardware-grid grid grid-cols-3 gap-2 divide-x divide-line-soft text-center">
                                <div className="flex flex-col px-1">
                                  <span className="ri-bench-hardware-label text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-1">
                                    GPU
                                  </span>
                                  <span className="ri-bench-hardware-value text-[11px] font-medium text-ink-secondary leading-tight break-words">
                                    {g?.gpu || "-"}
                                  </span>
                                </div>
                                <div className="flex flex-col px-1">
                                  <span className="ri-bench-hardware-label text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-1">
                                    CPU
                                  </span>
                                  <span className="ri-bench-hardware-value text-[11px] font-medium text-ink-secondary leading-tight break-words">
                                    {g?.cpu || "-"}
                                  </span>
                                </div>
                                <div className="flex flex-col px-1">
                                  <span className="ri-bench-hardware-label text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-1">
                                    RAM
                                  </span>
                                  <span className="ri-bench-hardware-value text-[11px] font-medium text-ink-secondary leading-tight break-words">
                                    {g?.ram || "-"}
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
            <div className="ri-bench-pager inline-flex items-center gap-3 rounded-full bg-surface-card ring-1 ring-line-soft px-3 py-2 shadow-surface">
              <button
                type="button"
                onClick={() => canPrev && setPage((p) => Math.max(0, p - 1))}
                disabled={!canPrev}
                className={
                  "h-9 w-9 rounded-full grid place-items-center " +
                  "ri-bench-page-button bg-surface-hover ring-1 ring-line-soft " +
                  "transition hover:bg-surface-hover-accent active:scale-95 " +
                  (canPrev ? "" : "opacity-40 cursor-not-allowed")
                }
                aria-label="Previous page"
              >
                <ChevronLeft className="ri-bench-page-icon h-5 w-5 text-ink-secondary" />
              </button>

              <div className="ri-bench-page-label min-w-[92px] text-center text-[13px] font-extrabold text-ink-secondary">
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
                  "ri-bench-page-button bg-surface-hover ring-1 ring-line-soft " +
                  "transition hover:bg-surface-hover-accent active:scale-95 " +
                  (canNext ? "" : "opacity-40 cursor-not-allowed")
                }
                aria-label="Next page"
              >
                <ChevronRight className="ri-bench-page-icon h-5 w-5 text-ink-secondary" />
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
