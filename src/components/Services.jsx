import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { urlFor } from "../sanityClient";
import About from "./About";
import homeCopy from "../lib/homeCopy";
import {
  fetchHomeSectionData,
  HOME_SECTION_DATA_KEYS,
} from "../lib/homeSectionData";
import useHomeSectionLinkHandler from "../lib/useHomeSectionLinkHandler";
import {
  Clock,
  Shield,
  Wrench,
  Zap,
  Video,
  Cpu,
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
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
  const handleHomeSectionLink = useHomeSectionLinkHandler();

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

  return (
    <section
      className="ri-services-section mx-auto max-w-[92rem] px-4 pt-6 pb-8 sm:px-6 sm:pb-10"
      aria-labelledby="services-heading"
    >
      <div className="ri-performance-overview">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div>
            <h2
              id="services-heading"
              className="ri-services-heading text-2xl font-bold tracking-tight text-info-text sm:text-3xl"
            >
              {data.heading || HOME_COPY.services.heading}
            </h2>
            <p className="ri-services-subheading mt-1 text-sm text-ink-secondary">
              {HOME_COPY.services.subheading}
            </p>
          </div>
          <Link
            to="/#packages"
            onClick={(event) => handleHomeSectionLink(event, "#packages")}
            className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-ink underline decoration-line-accent underline-offset-4 hover:text-accent"
          >
            Compare packages <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </div>

        <ul className="ri-services-benefits mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {HOME_COPY.services.cards.map((card, index) => {
            const Icon = ICONS[card.iconType];
            const customIcon = data.cards?.[index]?.customIcon;
            return (
              <li
                key={card.iconType}
                className="ri-service-card flex items-center gap-2.5 rounded-xl border border-line-input bg-panel p-3 sm:items-start sm:p-3.5"
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

      {showBenchmarks && (
        <section
          className="ri-bench-section mt-5"
          aria-labelledby="benchmark-heading"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4">
            <div>
              <h3
                id="benchmark-heading"
                className="text-base font-semibold text-ink"
              >
                Real game results
              </h3>
              <p className="text-xs text-ink-secondary">
                {beforeLabel} → {afterLabel} · FPS
              </p>
            </div>
            <Link
              to="/benchmarks"
              className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-ink-secondary hover:text-ink"
            >
              More results <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </div>
          <div
            className="ri-bench-shell grid gap-2 md:grid-cols-3"
            key={safePage}
          >
            {games.map((game, index) => {
              const before = positiveNumber(game.beforeFps);
              const after = positiveNumber(game.afterFps);
              const change =
                before !== null && after !== null
                  ? ((after - before) / before) * 100
                  : null;
              const percent =
                change !== null && Number.isFinite(change)
                  ? Math.round(change)
                  : null;
              const maximum = Math.max(before || 0, after || 0, 1);
              const logo =
                game.gameLogoUrl ||
                (game.gameLogo
                  ? urlFor(game.gameLogo).width(48).height(48).fit("max").url()
                  : null);
              return (
                <article
                  key={game._key || `${game.gameTitle}-${index}`}
                  className="ri-bench-card rounded-xl border border-line-input bg-surface-card px-3 py-3 sm:p-4"
                >
                  <div className="ri-bench-summary flex items-center justify-between gap-3 md:block">
                    <div className="flex min-w-0 items-center gap-2">
                      {logo && (
                        <img
                          src={logo}
                          alt=""
                          width={24}
                          height={24}
                          loading="lazy"
                          decoding="async"
                          className={`h-6 w-6 shrink-0 rounded-sm object-contain ${game.gameLogoUrl ? "bg-white p-0.5" : ""}`}
                        />
                      )}
                      <div className="min-w-0">
                        <h4 className="ri-bench-game-title text-sm font-bold leading-tight text-ink sm:text-base">
                          {game.gameTitle}
                        </h4>
                        <p className="mt-1 text-[11px] text-ink-secondary">
                          {game.metricLabel ||
                            data.benchMetricLabel ||
                            "Avg FPS"}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right md:mt-4 md:flex md:items-end md:justify-between md:gap-2 md:text-left">
                      <p className="ri-bench-number flex items-center justify-end gap-2 text-xl font-bold tabular-nums text-ink md:justify-start sm:text-2xl">
                        <span>
                          <span className="sr-only">{beforeLabel}: </span>
                          {before ?? "—"}
                        </span>
                        <span
                          className="text-sm font-normal text-ink-muted"
                          aria-hidden="true"
                        >
                          →
                        </span>
                        <span className="text-accent">
                          <span className="sr-only">{afterLabel}: </span>
                          {after ?? "—"}
                        </span>
                      </p>
                      {percent !== null && (
                        <p
                          className={`mt-1 text-xs font-semibold tabular-nums ${percent > 0 ? "text-accent" : "text-ink-secondary"}`}
                        >
                          {percent > 0 ? "+" : ""}
                          {percent}%
                        </p>
                      )}
                    </div>
                  </div>
                  <div
                    className="mt-3 hidden space-y-1.5 md:block"
                    aria-hidden="true"
                  >
                    <div className="h-1 rounded-full bg-surface-hover">
                      <div
                        className="ri-bench-before-fill h-full rounded-full bg-ink-muted"
                        style={{ width: `${((before || 0) / maximum) * 100}%` }}
                      />
                    </div>
                    <div className="h-1 rounded-full bg-surface-hover">
                      <div
                        className="ri-bench-after-fill h-full rounded-full bg-accent"
                        style={{ width: `${((after || 0) / maximum) * 100}%` }}
                      />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-start justify-between gap-x-6 gap-y-1">
            <details
              key={safePage}
              className="ri-bench-specs min-w-0 flex-1 text-xs text-ink-secondary"
            >
              <summary className="min-h-11 cursor-pointer py-3.5 hover:text-ink">
                PC specs for these results
              </summary>
              <div className="grid gap-3 pb-3 md:grid-cols-3">
                {games.map((game, index) => (
                  <div key={game._key || `${game.gameTitle}-${index}`}>
                    <p className="mb-1 font-semibold text-ink">
                      {game.gameTitle}
                    </p>
                    <dl className="space-y-1">
                      {[
                        { label: "GPU", value: game.gpu },
                        { label: "CPU", value: game.cpu },
                        { label: "RAM", value: game.ram },
                      ].map((detail) => (
                        <div key={detail.label} className="flex gap-2">
                          <dt className="w-8 shrink-0">{detail.label}</dt>
                          <dd>{detail.value || "Not provided"}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            </details>
            {pages.length > 1 && (
              <div className="ri-bench-pager flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Previous benchmark page"
                  disabled={safePage === 0}
                  onClick={() => setPage(Math.max(0, safePage - 1))}
                  className="ri-bench-page-button grid h-11 w-11 place-items-center rounded-full bg-surface-card text-ink-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft size={18} aria-hidden="true" />
                </button>
                <p
                  className="min-w-16 text-center text-xs text-ink-secondary"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {data.benchPagePrefix || "Page"} {safePage + 1} /{" "}
                  {pages.length}
                </p>
                <button
                  type="button"
                  aria-label="Next benchmark page"
                  disabled={safePage === pages.length - 1}
                  onClick={() =>
                    setPage(Math.min(pages.length - 1, safePage + 1))
                  }
                  className="ri-bench-page-button grid h-11 w-11 place-items-center rounded-full bg-surface-card text-ink-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-ink-muted">
            Results vary by hardware, game, and settings.
          </p>
        </section>
      )}
      <div className="mt-4">
        <About initialData={initialAboutData} compact />
      </div>
    </section>
  );
}
