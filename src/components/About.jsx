import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { fetchHomeSectionData, HOME_SECTION_DATA_KEYS, readHomeSectionData } from "../lib/homeSectionData";

/*  Record card design tokens — single source of truth.
    Two accents only: gold (title, via gold-flair-text CSS class) + cyan (everything else). */
const RC = {
  "--rc-bg":          "#0a1320",
  "--rc-bg-mid":      "#0e1526",
  "--rc-bg-deep":     "#07111f",
  "--rc-text":        "#f0f4f8",
  "--rc-text-muted":  "#94a3b8",
  "--rc-accent":      "#22d3ee",
  "--rc-accent-soft": "rgba(34, 211, 238, 0.12)",
  "--rc-border":      "rgba(34, 211, 238, 0.18)",
  "--rc-border-sub":  "rgba(34, 211, 238, 0.08)",
  "--rc-cta":         "#0d8fa0",
  "--rc-cta-end":     "#0a7585",
};

export default function About({ initialData = null }) {
  const [aboutData, setAboutData] = useState(
    () => initialData ?? readHomeSectionData(HOME_SECTION_DATA_KEYS.about)
  );

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
        className="mx-auto max-w-6xl pt-4 sm:pt-6 pb-16 px-4 sm:px-6 text-center"
        aria-hidden="true"
      >
        <div className="mt-6 min-h-[360px] rounded-2xl" style={{ ...RC, background: "var(--rc-bg)", border: "1px solid var(--rc-border-sub)" }} />
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

  return (
    <section
      id="about"
      className="mx-auto max-w-6xl pt-4 sm:pt-6 pb-16 px-4 sm:px-6 text-center"
    >
      <div className="mt-6">
        {/* Motion 1/3: Entrance — fade-up on scroll, 400ms */}
        <motion.div
          className="relative mx-auto max-w-6xl overflow-hidden rounded-2xl"
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
          {/* Top edge line — structural, marks card boundary */}
          <div
            className="absolute inset-x-0 top-0 h-px"
            style={{ background: "linear-gradient(to right, transparent, var(--rc-accent), transparent)", opacity: 0.35 }}
          />

          <div className="relative px-5 sm:px-8 py-5 sm:py-7">
            {/* Header: Label + Title + CTA */}
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-1.5 text-left">
                {/* Badge as plain uppercase label — no pill, no border, no bg */}
                <p className="text-[11px] font-bold uppercase tracking-[0.3em]" style={{ color: "var(--rc-accent)" }}>
                  {recordBadgeText}
                </p>
                <h3 className="text-2xl sm:text-3xl lg:text-[2.25rem] font-bold tracking-tight leading-tight">
                  <span className="gold-flair-text">{recordTitle}</span>
                </h3>
                <p className="text-xs sm:text-sm" style={{ color: "var(--rc-text-muted)" }}>
                  {recordSubtitle}
                </p>
              </div>

              {/* Motion 3/3: Hover — brightness lift + press-down */}
              <a
                href={leaderboardHref}
                target="_blank"
                rel="noreferrer"
                className="glow-button relative inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-xs sm:text-sm font-semibold text-white hover:brightness-110 active:translate-y-px transition-all duration-300 self-start shrink-0"
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

            {/* Stats: Pure typography hero + spec list */}
            <div className="mt-6 flex flex-col lg:flex-row gap-4 lg:gap-8 items-start">
              {/* Hero stat — pure type, no card treatment */}
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

              {/* Motion 2/3: Spec rows — staggered slide-in, 300ms each */}
              {specStats.length > 0 && (
                <div className="flex-1 flex flex-col justify-center">
                  {specStats.map((detail, index) => (
                    <motion.div
                      key={detail?._key || `${detail?.label || "detail"}-${index}`}
                      className="flex items-baseline gap-3 sm:gap-4 py-2.5"
                      style={index > 0 ? { borderTop: "1px solid var(--rc-border-sub)" } : undefined}
                      initial={{ opacity: 0, x: -12 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.3, delay: 0.1 + index * 0.06, ease: "easeOut" }}
                    >
                      <span className="w-11 sm:w-14 shrink-0 text-[11px] font-semibold uppercase tracking-[0.2em]" style={{ color: "var(--rc-text-muted)" }}>
                        {detail?.label || ""}
                      </span>
                      <span className="text-sm sm:text-base font-semibold truncate" style={{ color: "var(--rc-text)" }}>
                        {detail?.value || ""}
                      </span>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>

            {/* Note */}
            {recordNote && (
              <p
                className="mt-5 text-left text-[11px] sm:text-xs pt-4 font-semibold"
                style={{ borderTop: "1px solid var(--rc-border-sub)" }}
              >
                <span className="blue-glint-text">{recordNote}</span>
              </p>
            )}
          </div>
        </motion.div>
      </div>

      <div className="h-3" />
    </section>
  );
}
