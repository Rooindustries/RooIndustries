import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { urlFor } from "../sanityClient";
import About from "./About";
import homeCopy from "../lib/homeCopy";
import {
  fetchHomeSectionData,
  HOME_SECTION_DATA_KEYS,
} from "../lib/homeSectionData";
import {
  Clock,
  Shield,
  Wrench,
  Zap,
  Video,
  Cpu,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

const { HOME_COPY } = homeCopy;
const ICONS = {
  clock: Clock,
  shield: Shield,
  wrench: Wrench,
  zap: Zap,
  video: Video,
  cpu: Cpu,
};

const positiveNumber = (value) => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export default function Services({
  initialData = null,
  initialAboutData = null,
}) {
  const [data, setData] = useState(initialData);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (initialData !== null) setData(initialData);
  }, [initialData]);

  useEffect(() => {
    if (data !== null) return;
    let active = true;
    fetchHomeSectionData(HOME_SECTION_DATA_KEYS.services)
      .then((value) => {
        if (active) setData(value);
      })
      .catch(console.error);
    return () => {
      active = false;
    };
  }, [data]);

  const pages = Array.isArray(data?.benchPages)
    ? data.benchPages
        .map((entry) => ({
          games: Array.isArray(entry?.games)
            ? entry.games.filter(
                (game) =>
                  game &&
                  typeof game.gameTitle === "string" &&
                  game.gameTitle.trim(),
              )
            : [],
        }))
        .filter((entry) => entry.games.length)
    : [];
  const safePage = Math.min(page, Math.max(0, pages.length - 1));
  const games = pages[safePage]?.games || [];

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  if (!data) {
    return (
      <section
        className="mx-auto max-w-[92rem] px-4 py-8 sm:px-6"
        aria-hidden="true"
      >
        <div className="ri-services-skeleton min-h-[520px] rounded-2xl border border-line-input bg-skeleton sm:min-h-[380px]" />
      </section>
    );
  }

  const beforeLabel = data.benchBeforeLabel || "Before";
  const afterLabel = data.benchAfterLabel || "After Tune";
  const showBenchmarks = data.benchEnabled !== false && games.length > 0;
  const totalPages = pages.length;
  const canPrev = safePage > 0;
  const canNext = safePage < totalPages - 1;
  const badgeSuffix = data.benchBadgeSuffix || "FPS";
  const pagePrefix = data.benchPagePrefix || "Page";
  const gridClass =
    games.length === 1
      ? "grid grid-cols-1 gap-5"
      : games.length === 2
        ? "grid grid-cols-1 md:grid-cols-2 gap-5"
        : "grid grid-cols-1 md:grid-cols-3 gap-5";
  const containerClass =
    games.length === 1
      ? "max-w-xl"
      : games.length === 2
        ? "max-w-5xl"
        : "w-full";
  const calcPct = (before, after) => {
    const b = positiveNumber(before);
    const a = positiveNumber(after);
    if (b === null || a === null) return null;
    const percent = ((a - b) / b) * 100;
    return Number.isFinite(percent) ? Math.round(percent) : null;
  };
  const calcFill = (before, after) => {
    const b = positiveNumber(before) || 0;
    const a = positiveNumber(after) || 0;
    const maximum = Math.max(b, a, 1);
    return { bf: (b / maximum) * 100, af: (a / maximum) * 100 };
  };
  const contentSwap = {
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.98 },
    transition: { duration: 0.25, ease: "easeOut" },
  };

  return (
    <section
      className="ri-services-section mx-auto max-w-[92rem] px-4 pt-6 pb-8 sm:px-6 sm:pb-10"
      aria-labelledby="services-heading"
    >
      <div className="ri-performance-overview grid gap-6 xl:grid-cols-[minmax(300px,0.82fr)_minmax(0,2.18fr)] xl:items-stretch">
        <About initialData={initialAboutData} compact />
        <div className="ri-services-benefit-column flex min-w-0 flex-col">
          <div className="text-center">
            <div>
              <h2
                id="services-heading"
                className="ri-services-heading text-3xl font-bold tracking-tight text-info-text sm:text-4xl"
              >
                {data.heading || HOME_COPY.services.heading}
              </h2>
              <p className="ri-services-subheading mt-2 text-sm text-ink-secondary sm:text-[15px]">
                {HOME_COPY.services.subheading}
              </p>
            </div>
          </div>

          <ul className="ri-services-benefits mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:flex-1 xl:grid-rows-2 xl:gap-3">
            {HOME_COPY.services.cards.map((card, index) => {
              const Icon = ICONS[card.iconType];
              const customIcon = data.cards?.[index]?.customIcon;
              return (
                <li
                  key={card.iconType}
                  className="ri-service-card flex items-center gap-2.5 rounded-xl border border-line-input bg-panel p-3 sm:items-start sm:p-3.5 xl:items-center"
                >
                  <span className="ri-service-icon-shell grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line-input bg-surface-input">
                    {customIcon ? (
                      <img
                        src={urlFor(customIcon).width(32).url()}
                        alt=""
                        width={16}
                        height={16}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <Icon
                        className="ri-service-icon h-4 w-4 text-accent"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <div className="min-w-0">
                    <h3 className="ri-service-title text-[13px] font-semibold leading-5 text-ink sm:text-sm">
                      {card.title}
                    </h3>
                    <p className="ri-service-copy mt-0.5 hidden text-xs leading-[1.45] text-ink-secondary sm:block">
                      {card.description}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {showBenchmarks && (
        <>
          <div className="h-10" />

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
                {games.map((g, idx) => {
                  const pct = g ? calcPct(g?.beforeFps, g?.afterFps) : null;
                  const { bf, af } = g
                    ? calcFill(g?.beforeFps, g?.afterFps)
                    : { bf: 0, af: 0 };

                  const beforeNum = positiveNumber(g?.beforeFps);
                  const afterNum = positiveNumber(g?.afterFps);

                  const metricText =
                    g?.metricLabel || data?.benchMetricLabel || "Avg FPS";

                  return (
                    <motion.div
                      role="article"
                      aria-label={`${g.gameTitle} benchmark`}
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
                            initial={false}
                            animate={contentSwap.animate}
                            exit={contentSwap.exit}
                            transition={contentSwap.transition}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  {g?.gameLogoUrl || g?.gameLogo ? (
                                    <img
                                      src={
                                        g?.gameLogoUrl
                                          ? g.gameLogoUrl
                                          : urlFor(g.gameLogo)
                                              .width(64)
                                              .height(64)
                                              .fit("max")
                                              .url()
                                      }
                                      alt={
                                        g?.gameTitle
                                          ? `${g.gameTitle} logo`
                                          : "Game logo"
                                      }
                                      width={24}
                                      height={24}
                                      loading="lazy"
                                      decoding="async"
                                      className={`h-5 w-5 sm:h-6 sm:w-6 shrink-0 rounded-sm object-contain ${
                                        g?.gameLogoUrl ? "bg-white p-0.5" : ""
                                      }`}
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
                                {pct === null
                                  ? "-"
                                  : `${pct > 0 ? "+" : ""}${pct}% ${badgeSuffix}`}
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
                                      {beforeNum === null ? "-" : beforeNum}
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
                                      {afterNum === null ? "-" : afterNum}
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
                                {[
                                  { label: "GPU", value: g?.gpu || "-" },
                                  { label: "CPU", value: g?.cpu || "-" },
                                  { label: "RAM", value: g?.ram || "-" },
                                ].map((detail) => (
                                  <div
                                    key={detail.label}
                                    className="flex flex-col px-1"
                                  >
                                    <span className="ri-bench-hardware-label mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                                      {detail.label}
                                    </span>
                                    <span className="ri-bench-hardware-value break-words text-[11px] font-medium leading-tight text-ink-secondary">
                                      {detail.value}
                                    </span>
                                  </div>
                                ))}
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
                aria-label="Previous benchmark page"
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
                aria-label="Next benchmark page"
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
