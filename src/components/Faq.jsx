import React, { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { client } from "../sanityClient";

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

  // Smooth scroll & highlight the trust question
  useEffect(() => {
    const scrollToHash = () => {
      if (location.hash) {
        const id = location.hash.replace("#", "");
        const el = document.getElementById(id);
        if (el) {
          const yOffset = -80;
          const y =
            el.getBoundingClientRect().top + window.pageYOffset + yOffset;
          window.scrollTo({ top: y, behavior: "smooth" });
          el.classList.add("faq-highlight");
          setTimeout(() => el.classList.remove("faq-highlight"), 2500);
        } else {
          // Retry until Sanity content loads
          setTimeout(scrollToHash, 300);
        }
      } else {
        window.scrollTo({ top: 0 });
      }
    };

    const timeout = setTimeout(scrollToHash, 600);
    return () => clearTimeout(timeout);
  }, [location, sections]);

  return (
    <section className="relative z-10 pt-32 pb-24 px-6 text-white max-w-5xl mx-auto">
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
              {sec.questions?.map((q, idx) => (
                <div
                  key={idx}
                  id={
                    q.question?.toLowerCase().includes("how can i trust")
                      ? "trust"
                      : undefined
                  }
                  className="transition-all duration-500 rounded-lg"
                >
                  <h4 className="text-lg font-semibold text-sky-100">
                    {q.question}
                  </h4>
                  <p className="mt-1">{q.answer}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
