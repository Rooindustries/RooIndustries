import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { client } from "../sanityClient";

export default function Packages() {
  const [packages, setPackages] = useState([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    if (ref) {
      localStorage.setItem("referral", ref);
    }

    client
      .fetch(
        `*[_type == "package"] | order(_createdAt asc) {
          title,
          price,
          tag,
          features,
          buttonText,
          isHighlighted
        }`
      )
      .then(setPackages)
      .catch(console.error);
  }, []);

  return (
    <section className="relative z-10 pt-32 pb-24 text-center text-white">
      <h2 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Choose Your Package
      </h2>
      <div className="mt-4 flex justify-center">
        <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs sm:text-sm font-semibold bg-slate-900/80 text-cyan-100 border border-cyan-400/40 shadow-[0_0_18px_rgba(56,189,248,0.7)]">
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
          Fully Online
        </span>
      </div>

      <p className="mt-3 text-slate-300/80 text-sm sm:text-base">
        Select the tuning package that best fits your needs
      </p>

      <div className="mt-12 flex flex-col sm:flex-row justify-center gap-10 px-6 flex-wrap">
        {packages.map((p, i) => {
          const isXoc = p.title === "XOC / Extreme Overclocking";

          return (
            <div
              key={i}
              className={`relative w-full sm:w-[520px] bg-[#0b1120]/90 border rounded-xl p-6 transition-all duration-500 flex flex-col justify-between ${
                p.isHighlighted
                  ? "border-sky-400/60 shadow-[0_0_35px_rgba(56,189,248,0.4)] hover:shadow-[0_0_50px_rgba(56,189,248,0.6)]"
                  : "border-sky-600/40 shadow-[0_0_25px_rgba(14,165,233,0.25)] hover:shadow-[0_0_35px_rgba(14,165,233,0.4)]"
              }`}
            >
              {p.tag && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="inline-block whitespace-nowrap bg-sky-500 text-xs font-bold px-4 py-1 rounded-full shadow-[0_0_15px_rgba(56,189,248,0.6)]">
                    {p.tag}
                  </span>
                </div>
              )}

              <div>
                <h3 className="text-2xl font-semibold">{p.title}</h3>
                <p className="mt-6 text-5xl font-bold text-sky-400">
                  {p.price}
                </p>
                <ul className="mt-6 space-y-2 text-left text-sm text-slate-300 leading-relaxed">
                  {p.features?.map((f, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="text-sky-400 mt-1">✔</span>
                      <span className="flex-1">{f}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <Link
                to={`/booking?title=${encodeURIComponent(
                  p.title
                )}&price=${encodeURIComponent(
                  p.price
                )}&tag=${encodeURIComponent(p.tag || "")}&xoc=${
                  isXoc ? "1" : "0"
                }`}
                className="glow-button mt-8 w-full text-white py-3 rounded-md font-semibold shadow-[0_0_20px_rgba(56,189,248,0.4)] transition-all duration-300 text-center inline-flex items-center justify-center gap-2"
              >
                {p.buttonText}
                <span className="glow-line glow-line-top" />
                <span className="glow-line glow-line-right" />
                <span className="glow-line glow-line-bottom" />
                <span className="glow-line glow-line-left" />
              </Link>
            </div>
          );
        })}
      </div>
    </section>
  );
}
