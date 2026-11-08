import React, { useEffect, useState } from "react";
import { useContent } from "../lib/useContent";
import { AnimatePresence, motion } from "framer-motion";
import { urlFor } from "../lib/cmsImageUrl";
import About from "./About";
import homeCopy from "../lib/homeCopy";
import { HOME_SECTION_DATA_KEYS } from "../lib/homeSectionData";
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
  const { data } = useContent(HOME_SECTION_DATA_KEYS.services, initialData);
  const [page, setPage] = useState(0);

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
        className="mx-auto max-w-[80rem] px-4 py-8 sm:px-6"
        aria-hidden="true"
        data-section-placeholder=""
      >
        <div className="ri-services-skeleton min-h-[900px] rounded-2xl border border-line-input bg-skeleton md:min-h-[740px] lg:min-h-[440px]" />
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
        ? "grid grid-cols-1 lg:grid-cols-2 gap-5"
        : "grid grid-cols-1 lg:grid-cols-3 gap-5";
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
      className="ri-services-section mx-auto max-w-[80rem] px-4 pt-6 pb-8 sm:px-6 sm:pb-10"
      aria-labelledby="services-heading"
    >
      <div className="text-center">
        <h2
          id="services-heading"
          className="ri-services-heading section-title"
        >
          {data.heading || HOME_COPY.services.heading}
        </h2>
        <p className="section-lede">
          {HOME_COPY.services.subheading}
        </p>
      </div>

      <div className="ri-performance-overview mt-10 grid w-full gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-6">
        <ul className="grid grid-cols-2 gap-x-6 gap-y-8 sm:gap-x-8 md:grid-cols-3">
          {HOME_COPY.services.cards.map((card, index) => {
            const Icon = ICONS[card.iconType];
            const customIcon = data.cards?.[index]?.customIcon;
            return (
              <li
                key={card.iconType}
                className="ri-service-card flex flex-col items-center gap-3 border-t border-line-soft pt-5 text-center"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface-hover">
                  {customIcon ? (
                    <img
                      src={urlFor(customIcon).width(48).url()}
                      alt=""
                      width={24}
                      height={24}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <Icon
                      className="ri-service-icon h-6 w-6 text-accent"
                      aria-hidden="true"
                    />
                  )}
                </span>
                <div className="min-w-0">
                  <h3 className="ri-service-title text-base font-semibold leading-6 text-ink">
                    {card.title}
                  </h3>
                  <p className="ri-service-copy mt-1 text-sm leading-normal text-ink-secondary">
                    {card.description}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
        <About initialData={initialAboutData} compact />
      </div>

      {showBenchmarks && (
        <>
          <div className="h-10" />

          <motion.div
            layout
            className={`mx-auto ${containerClass}`}
          >
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
                      "overflow-hidden rounded-2xl p-5 " +
                      "bg-surface-card ring-1 ring-line-soft"
                    }
                  >
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
                            {metricText ? (
                              <div className="mt-3">
                                <span
                                  className={
                                    "ri-bench-metric-pill inline-flex items-center rounded-full px-2.5 py-1 text-[13px] font-semibold " +
                                    "bg-surface-hover text-ink-secondary"
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
                              "bg-surface-hover-accent text-accent ring-1 ring-line-accent"
                            }
                          >
                            {pct === null
                              ? "-"
                              : `${pct > 0 ? "+" : ""}${pct}% ${badgeSuffix}`}
                          </span>
                        </div>

                        <div className="mt-5">
                          <div className="space-y-3">
                            <div>
                              <div className="flex items-center justify-between text-[13px]">
                                <span className="ri-bench-before-label text-ink-secondary">
                                  {beforeLabel}
                                </span>
                                <span className="ri-bench-number font-extrabold text-ink">
                                  {beforeNum === null ? "-" : beforeNum}
                                </span>
                              </div>

                              <div className="ri-bench-before-track mt-2 h-2 rounded-full bg-surface-hover overflow-hidden">
                                <motion.div
                                  className="ri-bench-before-fill h-full rounded-full bg-ink-muted"
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
                              <div className="flex items-center justify-between text-[13px]">
                                <span className="ri-bench-after-label text-accent">
                                  {afterLabel}
                                </span>
                                <span className="ri-bench-number font-extrabold text-ink">
                                  {afterNum === null ? "-" : afterNum}
                                </span>
                              </div>

                              <div className="ri-bench-after-track mt-2 h-2 rounded-full bg-surface-hover overflow-hidden">
                                <motion.div
                                  className="ri-bench-after-fill h-full rounded-full bg-accent"
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
                        </div>

                        <div className="ri-bench-hardware mt-5 border-t border-line-soft pt-4">
                          <div className="grid grid-cols-[1fr_1fr_1.4fr] gap-3">
                            {[
                              { label: "GPU", value: g?.gpu || "-" },
                              { label: "CPU", value: g?.cpu || "-" },
                              { label: "RAM", value: g?.ram || "-" },
                            ].map((detail) => (
                              <div
                                key={detail.label}
                                className="flex min-w-0 flex-col"
                              >
                                <span className="ri-bench-hardware-label mb-1 text-xs font-semibold text-ink-muted">
                                  {detail.label}
                                </span>
                                <span className="ri-bench-hardware-value break-words text-[13px] font-medium leading-snug text-ink-secondary">
                                  {detail.value}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </motion.div>
                    </AnimatePresence>
                  </motion.div>
                );
              })}
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
