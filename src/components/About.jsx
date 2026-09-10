import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { fetchHomeSectionData, HOME_SECTION_DATA_KEYS } from "../lib/homeSectionData";

/* Record card design tokens — all theme accents derive from the active palette. */
const RC = {
  "--rc-bg":          "var(--color-surface-solid)",
  "--rc-bg-mid":      "var(--color-surface-card)",
  "--rc-bg-deep":     "var(--color-surface-elevated)",
  "--rc-text":        "var(--color-text-primary)",
  "--rc-text-muted":  "var(--color-text-muted)",
  "--rc-accent":      "var(--color-accent)",
  "--rc-accent-soft": "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  "--rc-border":      "var(--color-border-accent)",
  "--rc-border-sub":  "var(--color-border-soft)",
  "--rc-cta":         "var(--color-accent-strong)",
  "--rc-cta-end":     "var(--color-accent)",
};

export default function About({ initialData = null, compact = false }) {
  const [aboutData, setAboutData] = useState(() => initialData);

  useEffect(() => {
    if (initialData !== null) {
      setAboutData(initialData);
    }
  }, [initialData]);

  useEffect(() => {
    if (aboutData !== null) return;
    fetchHomeSectionData(HOME_SECTION_DATA_KEYS.about)
      .then(setAboutData)
      .catch(console.error);
  }, [aboutData]);

  if (!aboutData) {
    return (
      <section
        id="about"
        className={
          compact
            ? "h-full text-center"
            : "mx-auto max-w-6xl pt-4 sm:pt-6 pb-16 px-4 sm:px-6 text-center"
        }
        aria-hidden="true"
      >
        <div
          className={`${compact ? "min-h-[108px]" : "mt-6 min-h-[360px]"} rounded-2xl`}
          style={{ ...RC, background: "var(--rc-bg)", border: "1px solid var(--rc-border-sub)" }}
        />
      </section>
    );
  }

  const recordBadgeText = aboutData.recordBadgeText || "Proof";
  const recordTitle = aboutData.recordTitle || "3DMark Hall of Fame";
  const recordSubtitle =
    aboutData.recordSubtitle || "CPU Profile Global Hall of Fame - Official Entry";
  const recordButtonText = aboutData.recordButtonText || "See Official Leaderboard";
  const recordNote =
    aboutData.recordNote ||
    "Former #16 global CPU profile";
  const compactRecordNote = "Former #16";
  const recordDetailsFallback = [
    { label: "RANK", value: "#31", sub: "" },
    { label: "SCORE", value: "18829", sub: "" },
    { label: "DATE", value: "Jun 4, 2025", sub: "" },
    { label: "CPU", value: "AMD Ryzen 9 9950X3D", sub: "" },
    { label: "GPU", value: "NVIDIA GeForce RTX 5080", sub: "" },
  ];
  const recordDetailsRaw = Array.isArray(aboutData.recordDetails)
    ? aboutData.recordDetails
    : [];
  const recordDetailsSanity = recordDetailsRaw.filter(
    (item) => item && (item.label || item.value || item.sub)
  );
  const recordDetails =
    recordDetailsSanity.length > 0
      ? recordDetailsSanity
      : recordDetailsFallback;
  const leaderboardHref =
    aboutData.recordLink && typeof aboutData.recordLink === "string"
      ? aboutData.recordLink
      : "/benchmarks";

  const heroStat = recordDetails[0];
  const specStats = recordDetails.slice(1);

  if (compact) {
    return (
      <section id="about" className="ri-proof-card rounded-xl border border-line-input bg-surface-card px-3 sm:px-4" style={RC}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 py-2">
          <div className="flex items-center gap-3">
            {heroStat && (
              <p className="text-2xl font-bold tabular-nums text-ink">
                <span className="sr-only">{heroStat.label}: </span>{heroStat.value}
              </p>
            )}
            <div>
              <h3 className="ri-proof-title text-sm font-semibold text-ink">{recordTitle}</h3>
              <p className="ri-proof-note mt-0.5 text-[11px] text-ink-secondary">{compactRecordNote}</p>
            </div>
          </div>
          <a href={leaderboardHref} target="_blank" rel="noopener noreferrer" aria-label={recordButtonText} className="ri-proof-cta inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-ink underline decoration-line-accent underline-offset-4 hover:text-accent">
            Official entry
            <svg aria-hidden="true" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 19 19 5M5 5h14v14" /></svg>
          </a>
        </div>
        <details className="border-t border-line-soft text-xs text-ink-secondary">
          <summary className="min-h-11 cursor-pointer py-3.5 hover:text-ink">Record details</summary>
          <p className="mb-3">{recordSubtitle}</p>
          <dl className="grid grid-cols-2 gap-3 pb-4 sm:grid-cols-4">
            {specStats.map((detail, index) => (
              <div key={detail?._key || `${detail?.label || "detail"}-${index}`}>
                <dt className="mb-1 text-[10px] uppercase tracking-wider text-ink-muted">{detail.label}</dt>
                <dd className="font-medium text-ink">{detail.value}</dd>
                {detail.sub && <dd>{detail.sub}</dd>}
              </div>
            ))}
          </dl>
        </details>
      </section>
    );
  }

  return (
    <section
      id="about"
      className="mx-auto max-w-6xl pt-4 sm:pt-6 pb-16 px-4 sm:px-6 text-center"
    >
      <div className="mt-6">
        <motion.div
          className="ri-proof-card relative mx-auto max-w-6xl overflow-hidden rounded-2xl"
          style={{
            ...RC,
            background: "linear-gradient(135deg, var(--rc-bg), var(--rc-bg-mid), var(--rc-bg-deep))",
            border: "1px solid var(--rc-border)",
          }}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          <div
            className="absolute inset-x-0 top-0 h-px"
            style={{ background: "linear-gradient(to right, transparent, var(--rc-accent), transparent)", opacity: 0.35 }}
          />

          <div className="relative px-5 sm:px-8 py-5 sm:py-7">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-1.5 text-center lg:text-left">
                <p className="text-[11px] font-bold uppercase tracking-[0.3em]" style={{ color: "var(--rc-accent)" }}>
                  {recordBadgeText}
                </p>
                <h3 className="text-2xl sm:text-3xl lg:text-[2.25rem] font-bold tracking-tight leading-tight">
                  <span className="ri-proof-title gold-flair-text">{recordTitle}</span>
                </h3>
                <p className="text-xs sm:text-sm" style={{ color: "var(--rc-text-muted)" }}>
                  {recordSubtitle}
                </p>
              </div>

              <a
                href={leaderboardHref}
                target="_blank"
                rel="noopener noreferrer"
                className="ri-proof-cta glow-button relative inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-xs sm:text-sm font-semibold text-white hover:brightness-110 active:translate-y-px transition-all duration-300 self-center shrink-0 lg:self-start"
                style={{
                  background: "linear-gradient(135deg, var(--rc-cta), var(--rc-cta-end))",
                  border: "1px solid var(--rc-border)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
                }}
              >
                {recordButtonText}
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25" />
                </svg>
                <span className="glow-line glow-line-top" />
                <span className="glow-line glow-line-right" />
                <span className="glow-line glow-line-bottom" />
                <span className="glow-line glow-line-left" />
              </a>
            </div>

            <div className="mt-6 flex flex-col lg:flex-row gap-4 lg:gap-8 items-center lg:items-start">
              {heroStat && (
                <div className="flex flex-col items-center justify-center px-6 sm:px-10 py-3 lg:min-w-[160px]">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.3em]" style={{ color: "var(--rc-accent)" }}>
                    {heroStat.label}
                  </p>
                  <p className="mt-1.5 text-5xl sm:text-6xl font-black tracking-tight tabular-nums leading-none" style={{ color: "var(--rc-text)" }}>
                    {heroStat.value}
                  </p>
                </div>
              )}

              {specStats.length > 0 && (
                <div className="flex-1 flex flex-col items-center justify-center lg:items-stretch">
                  {specStats.map((detail, index) => (
                    <motion.div
                      key={detail?._key || `${detail?.label || "detail"}-${index}`}
                      className="flex flex-wrap items-baseline justify-center gap-2 sm:gap-4 py-2.5 lg:justify-start"
                      style={index > 0 ? { borderTop: "1px solid var(--rc-border-sub)" } : undefined}
                      initial={{ opacity: 0, x: -12 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.3, delay: 0.1 + index * 0.06, ease: "easeOut" }}
                    >
                      <span className="shrink-0 text-center text-[11px] font-semibold uppercase tracking-[0.2em] lg:w-14 lg:text-left" style={{ color: "var(--rc-text-muted)" }}>
                        {detail?.label || ""}
                      </span>
                      <span className="text-center text-sm sm:text-base font-semibold lg:truncate lg:text-left" style={{ color: "var(--rc-text)" }}>
                        {detail?.value || ""}
                      </span>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>

            {recordNote && (
              <p
                className="mt-5 text-center text-[11px] sm:text-xs pt-4 font-semibold lg:text-left"
                style={{ borderTop: "1px solid var(--rc-border-sub)" }}
              >
                <span className="ri-proof-note blue-glint-text">{recordNote}</span>
              </p>
            )}
          </div>
        </motion.div>
      </div>

      <div className="h-3" />
    </section>
  );
}
