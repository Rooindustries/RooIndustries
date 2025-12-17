import React, { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { client } from "../sanityClient";

const slugify = (text = "") =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "faq-item";

const UPGRADE_HASH = "upgrade-path";
const UPGRADE_GROUP_ATTR = "data-upgrade-group";
const UPGRADE_PATTERNS = [
  /upgrade path/i,
  /upgrade a single component/i,
  /every 6 months/i,
  /upgrade pc each 6 months/i,
  /reXOC’d?/i,
  /reXOCd/i,
  /re[- ]?xoc/i,
];
const isUpgradeQuestion = (question = "", answer = "") => {
  const target = `${question} ${answer}`;
  return UPGRADE_PATTERNS.some((re) => re.test(target));
};
const isUpgradeFollowUp = (question = "", answer = "") =>
  /one-time\s*\$?50 fee applies for a rexoc/i.test(`${question} ${answer}`);

export default function Faq() {
  const location = useLocation();
  const [sections, setSections] = useState([]);

  useEffect(() => {
    client
      .fetch(
        `*[_type == "faqSection"] | order(_createdAt asc) {
          sectionTitle,
          questions[]{question, answer}
        }`,
        {},
        { cache: "no-store" }
      )
      .then(setSections)
      .catch(console.error);
  }, []);

  // Smooth scroll & highlight anchored question
  useEffect(() => {
    const scrollToHash = () => {
      const hash = (location.hash || "").replace("#", "");
      if (!hash) {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }

      const primaryEl =
        document.getElementById(hash) ||
        document.querySelector(`[data-upgrade-anchor="true"]`);

      if (!primaryEl) {
        setTimeout(scrollToHash, 250);
        return;
      }

      const yOffset = -80;
      const targetY =
        primaryEl.getBoundingClientRect().top + window.pageYOffset + yOffset;

      const waitForScroll = (resolve) => {
        let lastY = window.scrollY;
        let stableCount = 0;
        const check = () => {
          const currentY = window.scrollY;
          const delta = Math.abs(currentY - targetY);
          stableCount = Math.abs(currentY - lastY) < 1 ? stableCount + 1 : 0;
          lastY = currentY;
          if (delta < 2 || stableCount >= 6) {
            resolve();
          } else {
            requestAnimationFrame(check);
          }
        };
        requestAnimationFrame(check);
      };

      window.scrollTo({ top: targetY, behavior: "smooth" });

      const startHighlight = () => {
        const highlightSingle = (el) => {
          el.classList.remove("faq-highlight");
          void el.offsetHeight; // force reflow
          el.classList.add("faq-highlight");
          setTimeout(() => el.classList.remove("faq-highlight"), 2600);
        };

        const targets =
          hash === UPGRADE_HASH ||
          primaryEl.getAttribute("data-upgrade-group") === "true"
            ? Array.from(
                document.querySelectorAll(`[${UPGRADE_GROUP_ATTR}="true"]`)
              )
            : [primaryEl];

        targets.forEach(highlightSingle);
      };

      // Start highlight once scroll settles (or after fallback timeout)
      let fallback = setTimeout(startHighlight, 700);
      waitForScroll(() => {
        clearTimeout(fallback);
        startHighlight();
      });
    };

    const timeout = setTimeout(scrollToHash, 300);
    return () => clearTimeout(timeout);
  }, [location, sections]);

  return (
    <section className="relative z-10 pt-32 pb-24 px-6 text-white max-w-5xl mx-auto">
      <style>{`
        .faq-highlight {
          position: relative;
        }
        .faq-highlight::after {
          content: "";
          position: absolute;
          inset: -10px -12px;
          border: 2px solid rgba(56,189,248,0.55);
          box-shadow: 0 0 28px rgba(56,189,248,0.35);
          border-radius: 12px;
          background: transparent;
          pointer-events: none;
          animation: faqFadeGlow 2s ease-in-out forwards;
        }
        @keyframes faqFadeGlow {
          0% { opacity: 0; }
          25% { opacity: 1; }
          75% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>

      {/* Heading */}
      <h2 className="text-4xl sm:text-5xl font-extrabold text-center tracking-tight text-sky-200 drop-shadow-[0_0_15px_rgba(56,189,248,0.5)]">
        Frequently Asked Questions
      </h2>
      <p className="mt-3 text-slate-150 text-center text-sm sm:text-base">
        Everything you need to know before scheduling your session
      </p>

      {/* FAQ Sections */}
      <div className="mt-12 space-y-16">
        {sections.map((sec, i) => (
          <div
            key={i}
            id={sec.sectionTitle.toLowerCase().replace(/\s+/g, "-")}
            className="backdrop-blur-sm bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl shadow-[0_0_25px_rgba(14,165,233,0.15)] p-8"
          >
            <h3 className="text-2xl font-bold text-sky-400 border-b border-sky-600/30 pb-2 mb-6">
              {sec.sectionTitle}
            </h3>

            <div className="space-y-6 text-slate-300 leading-relaxed">
              {sec.questions?.map((q, idx) => {
                const trustId = q.question
                  ?.toLowerCase()
                  .includes("how can i trust")
                  ? "trust"
                  : null;
                const upgradeId = isUpgradeQuestion(q.question, q.answer)
                  ? UPGRADE_HASH
                  : null;
                const upgradeGroup =
                  upgradeId === UPGRADE_HASH || isUpgradeFollowUp(q.question, q.answer);
                const questionId = trustId || upgradeId || slugify(q.question);

                return (
                  <div
                    key={idx}
                    id={questionId}
                    data-upgrade-anchor={upgradeId === UPGRADE_HASH ? "true" : undefined}
                    {...(upgradeGroup ? { [UPGRADE_GROUP_ATTR]: "true" } : {})}
                    className="transition-all duration-500 rounded-lg"
                  >
                    <h4 className="text-lg font-semibold text-sky-100">
                      {q.question}
                    </h4>
                    <p className="mt-1">{q.answer}</p>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
