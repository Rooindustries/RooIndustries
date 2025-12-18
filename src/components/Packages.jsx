import React, { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { client } from "../sanityClient";

export default function Packages() {
  const [packages, setPackages] = useState([]);
  const location = useLocation();
  const bookingState = {
    backgroundLocation: location.state?.backgroundLocation || location,
  };
  const UPGRADE_FAQ_HASH = "upgrade-path";

  const renderFeatureText = (text) => {
    if (!text) return null;

    const linkRegex = /(Future Upgrade Path)/i;

    const boldRegex = /(Lifetime)/i;

    return text.split(boldRegex).map((part, i) => {
      // If this part is "Lifetime", make it bold
      if (boldRegex.test(part)) {
        return (
          <span key={i} className="font-bold text-white">
            {part}
          </span>
        );
      }
      return part.split(linkRegex).map((subPart, j) => {
        if (linkRegex.test(subPart)) {
          return (
            <Link
              key={`${i}-${j}`}
              to={`/#${UPGRADE_FAQ_HASH}`}
              className="underline underline-offset-2 transition"
              style={{ color: "#22D3EE" }}
            >
              {subPart}
            </Link>
          );
        }
        return subPart;
      });
    });
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");

    if (ref) {
      try {
        localStorage.setItem("referral", ref);
      } catch (e) {
        console.error("Failed to store referral from link:", e);
      }
    }

    client
      .fetch(
        `*[_type == "package"] | order(coalesce(order, 999) asc, _createdAt asc) {
          title,
          price,
          tag,
          features,
          buttonText,
          isHighlighted,
          order
        }`
      )
      .then(setPackages)
      .catch(console.error);
  }, []);

  return (
    <section
      id="packages"
      className="relative z-10 pt-32 pb-24 text-center text-white"
    >
      <h2 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Choose Your Package
      </h2>

      <div className="mt-4 flex justify-center">
        <span className="inline-flex items-center gap-2.5 px-5 py-2 rounded-full text-sm sm:text-[0.95rem] font-semibold bg-slate-900/80 text-cyan-100 border border-cyan-400/40 shadow-[0_0_18px_rgba(56,189,248,0.7)]">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
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
              className={`relative w-full sm:w-[520px] border rounded-xl p-6 transition-all duration-500 flex flex-col justify-between bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 ${
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
                  {p.features?.map((f, idx) => {
                    return (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="text-sky-400 mt-1">✔</span>
                        <span className="flex-1">
                          {/* Use the strict helper function here */}
                          {renderFeatureText(f)}
                        </span>
                      </li>
                    );
                  })}
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
                state={bookingState}
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
