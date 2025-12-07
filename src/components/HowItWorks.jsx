import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FaDiscord, FaDownload, FaMicrochip, FaWindows } from "react-icons/fa";
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
      .then((res) => {
        console.log("Fetched HowItWorks data:", res);
        setData(res);
      })
      .catch((err) => console.error("Sanity fetch error:", err));
  }, []);

  if (!data) return null;

  const icons = {
    discord: <FaDiscord className="w-6 h-6" />,
    download: <FaDownload className="w-6 h-6" />,
    microchip: <FaMicrochip className="w-6 h-6" />,
    windows: <FaWindows className="w-6 h-6" />,
  };

  return (
    <section
      id="how-it-works"
      className="relative z-10 py-16 px-4 sm:px-6 text-white max-w-6xl mx-auto"
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
        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-8">
          {data.steps.map((s, i) => (
            <div
              key={i}
              className="group backdrop-blur-sm bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl p-6
                         shadow-[0_0_25px_rgba(14,165,233,0.15)] hover:shadow-[0_0_35px_rgba(14,165,233,0.25)]
                         transition-all duration-300"
            >
              {/* Step Badge + Icon */}
              <div className="flex items-center justify-between">
                {s.badge && (
                  <span
                    className="inline-flex items-center gap-2 text-xs font-semibold tracking-wide
                               text-sky-200/90 bg-sky-900/30 border border-sky-700/40 px-3 py-1 rounded-full
                               shadow-[0_0_12px_rgba(14,165,233,0.3)]"
                  >
                    {s.badge}
                  </span>
                )}
                <div
                  className="grid place-items-center w-11 h-11 rounded-xl border border-sky-700/40
                             bg-[#081225]/70 shadow-[0_0_18px_rgba(14,165,233,0.25)]"
                >
                  {icons[s.iconType] || null}
                </div>
              </div>

              {/* Step Content */}
              {s.title && (
                <h3 className="mt-4 text-xl font-bold text-white">{s.title}</h3>
              )}

              {s.text && (
                <p className="mt-2 text-slate-300/90 leading-relaxed">
                  {s.text}
                  {/* Add link only for Step 2 (Install a few apps) */}
                  {s.title?.toLowerCase().includes("install") && (
                    <span className="text-slate-400/90 font-medium">
                      {" "}
                      (
                      <Link
                        to="/faq#trust"
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
          ))}
        </div>
      )}
    </section>
  );
}
