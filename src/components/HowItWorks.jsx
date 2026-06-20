import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  PERF_TOGGLE_KEYS,
  getPerfToggleEnabled,
  subscribePerfDebugChanges,
} from "../lib/perfDebug";
import homeCopy from "../lib/homeCopy";
import { fetchHomeSectionData, HOME_SECTION_DATA_KEYS, readHomeSectionData } from "../lib/homeSectionData";
import useHomeSectionLinkHandler from "../lib/useHomeSectionLinkHandler";

const { HOME_COPY } = homeCopy;
const fallbackData = HOME_COPY.howItWorks;

export default function HowItWorks({ initialData = null }) {
  const [data, setData] = useState(
    () => initialData ?? readHomeSectionData(HOME_SECTION_DATA_KEYS.howItWorks) ?? fallbackData
  );
  const handleHomeSectionLink = useHomeSectionLinkHandler();

  useEffect(() => {
    if (initialData !== null) {
      setData(initialData);
    }
  }, [initialData]);
  const [pauseVideos, setPauseVideos] = useState(false);

  useEffect(() => {
    if (initialData !== null) return;
    if (readHomeSectionData(HOME_SECTION_DATA_KEYS.howItWorks) !== null) return;
    fetchHomeSectionData(HOME_SECTION_DATA_KEYS.howItWorks)
      .then((res) => { if (res) setData(res); })
      .catch((err) => console.error("Sanity fetch error:", err));
  }, [initialData]);

  useEffect(() => {
    const syncPauseState = () => {
      setPauseVideos(
        getPerfToggleEnabled(PERF_TOGGLE_KEYS.PAUSE_HOWITWORKS_VIDEOS)
      );
    };

    syncPauseState();
    const unsubscribePerf = subscribePerfDebugChanges(syncPauseState);
    window.addEventListener("roo-performance-mode-change", syncPauseState);
    return () => {
      unsubscribePerf();
      window.removeEventListener("roo-performance-mode-change", syncPauseState);
    };
  }, []);

  const videoByStepIndex = {
    0: "discordvideo",
    1: "instructions",
    2: "bios",
    3: "tuning",
  };
  const VideoBadge = ({ name, pauseVideos }) => {
    const cardRef = useRef(null);
    const videoRef = useRef(null);

    useEffect(() => {
      const node = videoRef.current;
      if (!node) return;

      if (pauseVideos) {
        node.pause();
        return;
      }

      if (typeof IntersectionObserver === "undefined" || !cardRef.current) {
        node.play().catch(() => {});
        return;
      }

      let visible = false;
      const observer = new IntersectionObserver(
        (entries) => {
          visible = Boolean(entries[0]?.isIntersecting);
          if (visible && !document.hidden) {
            node.play().catch(() => {});
          } else {
            node.pause();
          }
        },
        { rootMargin: "200px 0px" }
      );

      const onVisibility = () => {
        if (document.hidden) { node.pause(); }
        else if (visible) { node.play().catch(() => {}); }
      };

      observer.observe(cardRef.current);
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        observer.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }, [pauseVideos]);

    if (!name) return null;

    const webm = `/videos/${name}.webm`;
    const mp4 = `/videos/${name}.mp4`;
    const poster = `/posters/${name}.jpg`;

    return (
      <div
        ref={cardRef}
        className="ri-hiw-video relative overflow-hidden rounded-2xl border border-line-input bg-surface-card
                   shadow-[var(--shadow-card-glow-info)]
                   w-[calc(100%+0.75rem)] sm:w-[calc(100%+1rem)] -mx-1.5 sm:-mx-2 aspect-video sm:aspect-[16/10]"
      >
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          fetchPriority="low"
          poster={poster}
        >
          <source src={webm} type="video/webm" />
          <source src={mp4} type="video/mp4" />
        </video>

        <div className="absolute inset-0 bg-gradient-to-br from-sky-500/12 via-transparent to-cyan-500/12" />
        <div className="absolute inset-0 ring-1 ring-inset ring-white/10" />
      </div>
    );
  };

  return (
    <section className="ri-hiw-section relative z-10 py-16 px-4 sm:px-6 text-ink max-w-[110rem] mx-auto">
      {data.title && (
        <h2 className="ri-hiw-heading text-4xl sm:text-5xl font-extrabold text-center tracking-tight text-info-text drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
          {data.title}
        </h2>
      )}

      {data.subtitle && (
        <p className="ri-hiw-subtitle mt-3 text-ink-secondary text-center text-sm sm:text-base">
          {data.subtitle}
        </p>
      )}

      {data.steps?.length > 0 && (
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {data.steps.map((s, i) => (
            <div
              key={i}
              className="ri-hiw-card group scroll-blur-lite backdrop-blur-sm bg-surface-card border border-line-input rounded-2xl p-4
                         shadow-[var(--shadow-card-glow-info)] hover:shadow-[var(--shadow-card-glow)]
                         transition-all duration-300"
            >
              {/* Video stacked on top of the text content */}
              <div className="flex flex-col items-center gap-5 text-center">
                <div className="w-full flex justify-center">
                  <VideoBadge
                    name={videoByStepIndex[i]}
                    pauseVideos={pauseVideos}
                  />
                </div>

                <div className="w-full">
                  {s.badge && (
                    <span
                      className="ri-hiw-step-badge inline-flex items-center gap-2 text-sm sm:text-base font-semibold tracking-wide
                                 text-info-text bg-info-soft border border-line-input px-3.5 py-1.5 rounded-full
                                 shadow-[var(--shadow-step-badge)]"
                    >
                      {s.badge}
                    </span>
                  )}

                  {s.title && (
                    <h3 className="ri-hiw-step-title mt-4 text-xl font-bold text-ink">
                      {s.title}
                    </h3>
                  )}

                  {s.text && (
                    <p className="ri-hiw-step-copy mt-2 text-ink-secondary leading-relaxed">
                      {s.text}
                      {s.title?.toLowerCase().includes("install") && (
                        <span className="ri-hiw-trust-copy text-ink-muted font-medium">
                          {" "}
                          (
                          <Link
                            to="/#trust"
                            onClick={(event) =>
                              handleHomeSectionLink(event, "#trust")
                            }
                            className="ri-hiw-trust-link text-accent font-semibold transition-colors duration-300 hover:text-[color:var(--color-link-hover)]"
                          >
                            Read How can I trust you? Is this secure?
                          </Link>
                          )
                        </span>
                      )}
                    </p>
                  )}
                </div>

              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
