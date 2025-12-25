import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../sanityClient";

export default function HowItWorks() {
  const [data, setData] = useState(null);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "howItWorks"][0]{
          title,
          subtitle,
          steps[]{badge, title, text, iconType}
        }`
      )
      .then((res) => setData(res))
      .catch((err) => console.error("Sanity fetch error:", err));
  }, []);

  if (!data) return null;

  const videoByStepIndex = {
    0: "discordvideo",
    1: "instructions",
    2: "bios",
    3: "tuning",
  };

  const VideoBadge = ({ name }) => {
    if (!name) return null;

    const webm = `/videos/${name}.webm`;
    const mp4 = `/videos/${name}.mp4`;

    return (
      <div
        className="relative overflow-hidden rounded-2xl border border-sky-700/40 bg-[#081225]/70
                   shadow-[0_0_26px_rgba(14,165,233,0.3)]
                   w-[calc(100%+0.75rem)] sm:w-[calc(100%+1rem)] -mx-1.5 sm:-mx-2 aspect-[16/10]"
      >
        <video
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
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
    <section
      id="how-it-works"
      className="relative z-10 py-16 px-4 sm:px-6 text-white max-w-[110rem] mx-auto"
    >
      {data.title && (
        <h2 className="text-4xl sm:text-5xl font-extrabold text-center tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
          {data.title}
        </h2>
      )}

      {data.subtitle && (
        <p className="mt-3 text-slate-150 text-center text-sm sm:text-base">
          {data.subtitle}
        </p>
      )}

      {data.steps?.length > 0 && (
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {data.steps.map((s, i) => (
            <div
              key={i}
              className="group backdrop-blur-sm bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl p-4
                         shadow-[0_0_25px_rgba(14,165,233,0.15)] hover:shadow-[0_0_35px_rgba(14,165,233,0.25)]
                         transition-all duration-300"
            >
              {/* Video stacked on top of the text content */}
              <div className="flex flex-col items-center gap-5 text-center">
                <div className="w-full flex justify-center">
                  <VideoBadge name={videoByStepIndex[i]} />
                </div>

                <div className="w-full">
                  {s.badge && (
                    <span
                      className="inline-flex items-center gap-2 text-sm sm:text-base font-semibold tracking-wide
                                 text-sky-100 bg-sky-900/40 border border-sky-700/50 px-3.5 py-1.5 rounded-full
                                 shadow-[0_0_12px_rgba(14,165,233,0.3)]"
                    >
                      {s.badge}
                    </span>
                  )}

                  {s.title && (
                    <h3 className="mt-4 text-xl font-bold text-white">
                      {s.title}
                    </h3>
                  )}

                  {s.text && (
                    <p className="mt-2 text-slate-300/90 leading-relaxed">
                      {s.text}
                      {s.title?.toLowerCase().includes("install") && (
                        <span className="text-slate-400/90 font-medium">
                          {" "}
                          (
                          <Link
                            to="/#trust"
                            className="bg-gradient-to-r from-sky-400 to-cyan-400 bg-clip-text text-transparent font-semibold
                                       hover:from-cyan-300 hover:to-sky-300 transition-all duration-300
                                       hover:drop-shadow-[0_0_6px_rgba(56,189,248,0.8)]"
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
