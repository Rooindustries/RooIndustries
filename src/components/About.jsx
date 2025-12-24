import React, { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { client, urlFor } from "../sanityClient";
import ImageZoomModal from "../components/ImageZoomModal";
import {
  getPreloadedState,
  isReactSnap,
  setSnapState,
} from "../utils/prerenderState";

export default function About() {
  const [preloaded] = useState(() => getPreloadedState("home.about"));
  const hasPreloaded = typeof preloaded !== "undefined";
  const [aboutData, setAboutData] = useState(() => preloaded ?? null);
  const [zoomSrc, setZoomSrc] = useState("");

  useEffect(() => {
    if (hasPreloaded) return;
    client
      .fetch(
        `*[_type == "about"][0]{
          title,
          description,
          recordTitle,
          recordImage{
            ...,
            "dimensions": asset->metadata.dimensions
          },
          recordLink
        }`
      )
      .then((data) => {
        setAboutData(data);
        if (isReactSnap()) {
          setSnapState("home.about", data);
        }
      })
      .catch(console.error);
  }, [hasPreloaded]);

  if (!aboutData) return null;

  const recordImageUrl = aboutData.recordImage
    ? urlFor(aboutData.recordImage).url()
    : "";
  const recordDimensions = aboutData.recordImage?.dimensions;
  const recordAlt = aboutData.recordTitle
    ? `Leaderboard record image: ${aboutData.recordTitle}`
    : "Leaderboard record image";
  const leaderboardHref =
    aboutData.recordLink && typeof aboutData.recordLink === "string"
      ? aboutData.recordLink
      : "/benchmarks";

  return (
    <section
      id="about"
      className="mx-auto max-w-6xl py-16 px-4 sm:px-6 text-center"
    >
      {zoomSrc && (
        <ImageZoomModal
          src={zoomSrc}
          alt={recordAlt}
          onClose={() => setZoomSrc("")}
        />
      )}

      <h2 className="text-[48px] sm:text-[48px] md:text-[48px] font-extrabold tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        {aboutData.title}
      </h2>

      <div className="mx-auto mt-8 max-w-4xl rounded-2xl bg-[#1b2430] p-8 sm:p-10 ring-1 ring-[#2b3a4a] text-left text-base sm:text-lg leading-8 sm:leading-9 text-slate-200/95 whitespace-pre-line">
        {aboutData.description}
      </div>

      <div className="mt-12 flex flex-col items-center">
        <div className="flex items-center gap-2 mb-4">
          <Zap className="text-cyan-500 w-6 h-6 animate-pulse drop-shadow-[0_0_6px_#00ffff]" />
          <h3 className="text-cyan-400 font-semibold text-xl sm:text-2xl tracking-wide drop-shadow-[0_0_8px_#00ffff]">
            {aboutData.recordTitle}
          </h3>
          <Zap className="text-cyan-500 w-6 h-6 animate-pulse drop-shadow-[0_0_6px_#00ffff]" />
        </div>

        {aboutData.recordImage && (
          <>
            <figure className="m-0">
              <img
                src={recordImageUrl}
                alt={recordAlt}
                width={recordDimensions?.width}
                height={recordDimensions?.height}
                loading="lazy"
                decoding="async"
                className="rounded-xl shadow-lg border border-[#2b3a4a] hover:border-cyan-500 transition-all duration-300 cursor-pointer"
                onClick={() => setZoomSrc(recordImageUrl)}
              />
              <figcaption className="sr-only">{recordAlt}</figcaption>
            </figure>
            <a
              href={leaderboardHref}
              target="_blank"
              rel="noreferrer"
              className="mt-4 glow-button relative inline-flex items-center justify-center gap-2 rounded-md px-4 sm:px-6 py-2.5 sm:py-3.5 text-sm sm:text-base font-semibold text-white ring-1 ring-sky-700/60 hover:text-white active:translate-y-px transition-all duration-300"
              style={{
                background: "#0b63d1",
                backgroundImage: "none",
                boxShadow:
                  "0 0 26px rgba(59,130,246,0.35), 0 0 38px rgba(59,130,246,0.2)",
                animation: "none",
              }}
            >
              View Leaderboard
              <span className="glow-line glow-line-top" />
              <span className="glow-line glow-line-right" />
              <span className="glow-line glow-line-bottom" />
              <span className="glow-line glow-line-left" />
            </a>
          </>
        )}
      </div>

      <div className="h-3" />
    </section>
  );
}
