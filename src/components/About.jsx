import React, { useEffect, useState } from "react";
import { client } from "../sanityClient";

export default function About() {
  const [aboutData, setAboutData] = useState(null);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "about"][0]{
          recordTitle,
          recordBadgeText,
          recordSubtitle,
          recordButtonText,
          recordNote,
          recordDetails,
          recordLink
        }`
      )
      .then(setAboutData)
      .catch(console.error);
  }, []);

  if (!aboutData) return null;

  const recordBadgeText = aboutData.recordBadgeText || "Proof";
  const recordTitle = aboutData.recordTitle || "3DMark Hall of Fame";
  const recordSubtitle =
    aboutData.recordSubtitle || "Top 20 global CPU profile - official entry";
  const recordButtonText = aboutData.recordButtonText || "See official entry";
  const recordNote =
    aboutData.recordNote ||
    "We don't just promise performance - we show the receipt.";
  const recordDetailsFallback = [
    { label: "Rank", value: "#20", sub: "Global CPU profile" },
    { label: "Score", value: "18829", sub: "Verified" },
    { label: "Date", value: "Jun 4, 2025", sub: "Submission" },
    { label: "CPU", value: "AMD Ryzen 9 9950X3D", sub: "Tuned profile" },
    { label: "GPU", value: "NVIDIA GeForce RTX 5080", sub: "Validated config" },
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

  return (
    <section
      id="about"
      className="mx-auto max-w-6xl py-16 px-4 sm:px-6 text-center"
    >
      <div className="mt-6">
        <div className="mx-auto max-w-6xl rounded-2xl border border-sky-700/40 bg-gradient-to-br from-[#0b1d33] via-[#0a1324] to-[#06101f] shadow-[0_0_32px_rgba(14,165,233,0.2)] overflow-hidden">
          <div className="relative px-4 sm:px-6 py-3.5 sm:py-4.5">
            <div className="pointer-events-none absolute inset-0 opacity-50 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.35),transparent_55%)]" />
            <div className="relative z-10 flex flex-col gap-3">
              <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 text-left">
                  <span className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-300/40 bg-cyan-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-200">
                    <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_10px_rgba(34,211,238,0.8)]" />
                    {recordBadgeText}
                  </span>
                  <div>
                    <h3 className="text-xl sm:text-2xl font-semibold">
                      <span className="gold-flair-text">{recordTitle}</span>
                    </h3>
                    <p className="text-[11px] sm:text-xs text-slate-400">
                      {recordSubtitle}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a
                    href={leaderboardHref}
                    target="_blank"
                    rel="noreferrer"
                    className="glow-button relative inline-flex items-center justify-center gap-2 rounded-full px-4 sm:px-5 py-2 text-xs sm:text-sm font-semibold text-white ring-1 ring-sky-700/60 hover:text-white active:translate-y-px transition-all duration-300"
                    style={{
                      background: "#0b63d1",
                      backgroundImage: "none",
                      boxShadow:
                        "0 0 26px rgba(59,130,246,0.35), 0 0 38px rgba(59,130,246,0.2)",
                      animation: "none",
                    }}
                  >
                    {recordButtonText}
                    <span className="glow-line glow-line-top" />
                    <span className="glow-line glow-line-right" />
                    <span className="glow-line glow-line-bottom" />
                    <span className="glow-line glow-line-left" />
                  </a>
                </div>
              </div>

              <div className="rounded-2xl border border-sky-700/40 bg-gradient-to-r from-[#071122] via-[#0a1b32] to-[#071122] p-2.5 sm:p-3 shadow-[0_0_20px_rgba(15,23,42,0.5)]">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5 text-left">
                  {recordDetails.map((detail, index) => (
                    <div
                      key={detail?._key || `${detail?.label || "detail"}-${index}`}
                      className="flex h-full flex-col rounded-2xl border border-sky-700/30 bg-slate-900/40 px-3 py-2"
                    >
                      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 whitespace-nowrap">
                        {detail?.label || ""}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-sky-100 truncate whitespace-nowrap">
                        {detail?.value || ""}
                      </p>
                      <p className="mt-auto text-[11px] text-slate-400 truncate whitespace-nowrap">
                        {detail?.sub || ""}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {recordNote && (
                <p className="text-left text-[11px] sm:text-xs text-slate-300/80">
                  {recordNote}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="h-3" />
    </section>
  );
}
