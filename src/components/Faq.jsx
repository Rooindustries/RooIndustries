import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ChevronDown } from "lucide-react";
import { useLocation } from "react-router-dom";
import { client } from "../sanityClient";

const slugify = (text = "") =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "faq-item";

const UPGRADE_HASH = "upgrade-path";
const TRUST_HASH = "trust";
const UPGRADE_PATTERNS = [
  /upgrade path/i,
  /upgrade a single component/i,
  /every 6 months/i,
  /upgrade pc each 6 months/i,
  /rexoc.?td?/i,
  /rexocd/i,
  /re[- ]?xoc/i,
];

const isUpgradeQuestion = (question = "", answer = "") => {
  const target = `${question} ${answer}`;
  return UPGRADE_PATTERNS.some((re) => re.test(target));
};

const getQuestionId = (question = "", answer = "") => {
  if (question.toLowerCase().includes("how can i trust")) return TRUST_HASH;
  if (isUpgradeQuestion(question, answer)) return UPGRADE_HASH;
  return slugify(question);
};

export default function FaqSection() {
  const location = useLocation();
  const [sections, setSections] = useState([]);
  const [faqCopy, setFaqCopy] = useState(null);
  const [activeCategory, setActiveCategory] = useState(null);
  const [openQuestions, setOpenQuestions] = useState({});
  const categoryRefs = useRef([]);

  const getCategoryId = (title = "", index = 0) =>
    slugify(title) || `category-${index + 1}`;

  const scrollWithOffset = (id, behavior = "smooth") => {
    const el = typeof id === "string" ? document.getElementById(id) : id;
    if (!el) return false;

    const yOffset = -96;
    const y = el.getBoundingClientRect().top + window.scrollY + yOffset;
    window.scrollTo({ top: y, behavior });
    return true;
  };

  const scrollToCategory = (index, behavior = "smooth") => {
    const el = categoryRefs.current[index];
    if (el) scrollWithOffset(el, behavior);
  };

  const focusCategory = (index, behavior = "smooth") => {
    setActiveCategory(index);
    setTimeout(() => scrollToCategory(index, behavior), 120);
  };

  const toggleCategory = (index) => {
    setActiveCategory((prev) => {
      const next = prev === index ? null : index;
      if (next !== null) {
        setTimeout(() => scrollToCategory(next), 100);
      }
      return next;
    });
  };

  const toggleQuestion = (categoryIndex, questionIndex) => {
    setOpenQuestions((prev) => {
      const categoryState = prev[categoryIndex] || {};
      return {
        ...prev,
        [categoryIndex]: {
          ...categoryState,
          [questionIndex]: !categoryState[questionIndex],
        },
      };
    });
  };

  const handleNextCategory = (currentIndex) => {
    const nextIndex = currentIndex + 1;
    if (nextIndex >= sections.length) return;
    focusCategory(nextIndex);
  };

  useEffect(() => {
    client
      .fetch(
        `*[_type == "faqSettings"][0]{
          eyebrow,
          title,
          subtitle
        }`,
        {},
        { cache: "no-store" }
      )
      .then(setFaqCopy)
      .catch(console.error);
  }, []);

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
      .then((res) => {
        setSections(res || []);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!sections.length) return;

    const hash = (location.hash || "").replace("#", "");
    if (!hash) return;

    if (hash === "faq") {
      scrollWithOffset("faq");
      return;
    }

    const questionMatch = sections.reduce((match, sec, sIdx) => {
      if (match) return match;
      const qIdx = sec.questions?.findIndex(
        (q) => getQuestionId(q.question, q.answer) === hash
      );
      if (qIdx >= 0) return { categoryIndex: sIdx, questionIndex: qIdx };
      return null;
    }, null);

    if (questionMatch) {
      const { categoryIndex, questionIndex } = questionMatch;
      setActiveCategory(categoryIndex);
      setOpenQuestions((prev) => ({
        ...prev,
        [categoryIndex]: {
          ...(prev[categoryIndex] || {}),
          [questionIndex]: true,
        },
      }));
      setTimeout(() => scrollWithOffset(hash), 140);
      return;
    }

    const categoryIndex = sections.findIndex(
      (sec, idx) => getCategoryId(sec.sectionTitle, idx) === hash
    );
    if (categoryIndex >= 0) {
      focusCategory(categoryIndex);
    }
  }, [location.hash, sections]);

  const isLoading = !sections.length;
  const eyebrowText = faqCopy?.eyebrow || "Answers without the fluff";
  const headingText = faqCopy?.title || "Frequently Asked Questions";
  const subtitleText =
    faqCopy?.subtitle ||
    "Click a category to reveal the questions, then tap a question to expand its answer.";

  return (
    <section
      id="faq"
      className="relative z-10 scroll-mt-32 pt-20 pb-24 px-4 sm:px-6 text-white"
    >
      <div className="relative max-w-6xl mx-auto">
        <div className="text-center">
          <span className="inline-flex items-center gap-2 px-4 py-1 rounded-full bg-sky-900/40 border border-sky-500/30 text-xs sm:text-sm font-semibold uppercase tracking-wide text-cyan-100 shadow-[0_0_18px_rgba(56,189,248,0.5)]">
            {eyebrowText}
          </span>
          <h2 className="mt-4 text-4xl sm:text-5xl font-extrabold tracking-tight text-sky-100 drop-shadow-[0_0_20px_rgba(56,189,248,0.35)]">
            {headingText}
          </h2>
          <p className="mt-3 text-slate-200/80 text-sm sm:text-base">
            {subtitleText}
          </p>
        </div>

        <div className="mt-12 space-y-5">
          {isLoading && (
            <div className="rounded-2xl border border-sky-800/30 bg-slate-900/60 p-6">
              <div className="h-4 w-24 rounded-full bg-sky-800/60 animate-pulse" />
              <div className="mt-3 space-y-2">
                <div className="h-3 w-full rounded bg-sky-900/60 animate-pulse" />
                <div className="h-3 w-5/6 rounded bg-sky-900/60 animate-pulse" />
                <div className="h-3 w-4/6 rounded bg-sky-900/60 animate-pulse" />
              </div>
            </div>
          )}

          {sections.map((sec, i) => {
            const isOpen = activeCategory === i;
            const nextCategory = sections[i + 1];
            const categoryId = getCategoryId(sec.sectionTitle, i);

            return (
              <div
                key={categoryId}
                id={categoryId}
                ref={(el) => (categoryRefs.current[i] = el)}
                className={`relative rounded-2xl border transition-all duration-200 ${
                  isOpen
                    ? "border-cyan-400/60 shadow-[0_0_20px_rgba(56,189,248,0.25)] bg-slate-900/75"
                    : "border-sky-800/50 shadow-[0_0_14px_rgba(14,165,233,0.18)] hover:border-cyan-300/60 bg-slate-950/50"
                }`}
              >
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => toggleCategory(i)}
                    aria-expanded={isOpen}
                    className="w-full flex items-center justify-between gap-4 px-5 sm:px-7 py-5 text-left"
                  >
                    <div className="flex items-center gap-4 sm:gap-5">
                      <div className="h-12 w-12 sm:h-14 sm:w-14 rounded-xl bg-gradient-to-br from-sky-500/80 to-cyan-400/80 border border-cyan-300/60 shadow-[0_0_20px_rgba(56,189,248,0.55)] flex items-center justify-center text-xl font-extrabold text-slate-950">
                        {String(i + 1).padStart(2, "0")}
                      </div>
                      <div>
                        <p className="text-[12px] uppercase tracking-[0.2em] text-cyan-200/80">
                          Category
                        </p>
                        <h3 className="text-xl sm:text-2xl font-bold text-white">
                          {sec.sectionTitle}
                        </h3>
                        <p className="text-xs text-slate-300/70 mt-1">
                          {sec.questions?.length || 0} question
                          {sec.questions?.length === 1 ? "" : "s"}
                        </p>
                      </div>
                    </div>

                    <motion.span
                      animate={{ rotate: isOpen ? 180 : 0 }}
                      transition={{ duration: 0.22 }}
                      className="flex h-10 w-10 items-center justify-center rounded-full border border-sky-800/60 bg-slate-900/70 text-cyan-200 shadow-[0_0_12px_rgba(56,189,248,0.22)]"
                    >
                      <ChevronDown className="h-5 w-5" />
                    </motion.span>
                  </button>

                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        key="category-body"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18, ease: "easeInOut" }}
                        className="px-5 sm:px-7 pb-6 overflow-hidden"
                      >
                        <div className="mt-1 space-y-4">
                          {sec.questions?.map((q, idx) => {
                            const questionId = getQuestionId(
                              q.question,
                              q.answer
                            );
                            const isAnswerOpen =
                              openQuestions?.[i]?.[idx] || false;

                            return (
                              <div
                                key={`${questionId}-${idx}`}
                                id={questionId}
                                className="rounded-xl border border-sky-800/60 bg-slate-950/60 px-4 sm:px-5 py-3 transition-all duration-200 hover:border-cyan-300/60"
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleQuestion(i, idx)}
                                  className="w-full flex items-center justify-between gap-3 text-left"
                                  aria-expanded={isAnswerOpen}
                                >
                                  <div className="flex-1 text-[15px] sm:text-[16px] font-semibold text-sky-50">
                                    {q.question}
                                  </div>
                                  <motion.span
                                    animate={{ rotate: isAnswerOpen ? 180 : 0 }}
                                    transition={{ duration: 0.12 }}
                                    className="ml-2 text-cyan-200"
                                  >
                                    <ChevronDown className="h-4 w-4" />
                                  </motion.span>
                                </button>

                                <AnimatePresence initial={false}>
                                  {isAnswerOpen && (
                                    <motion.div
                                      key="answer"
                                      initial={{ height: 0, opacity: 0 }}
                                      animate={{ height: "auto", opacity: 1 }}
                                      exit={{ height: 0, opacity: 0 }}
                                      transition={{
                                        duration: 0.18,
                                        ease: "easeInOut",
                                      }}
                                      className="overflow-hidden"
                                    >
                                      <div className="mt-3 text-slate-200/90 leading-relaxed">
                                        {q.answer}
                                      </div>
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </div>
                            );
                          })}

                          {!sec.questions?.length && (
                            <div className="text-slate-300/70 text-sm">
                              No questions added to this category yet.
                            </div>
                          )}

                          {nextCategory && (
                            <div className="pt-2 flex justify-end">
                              <button
                                type="button"
                                onClick={() => handleNextCategory(i)}
                                className="group inline-flex items-center gap-2 rounded-full border border-cyan-400/70 bg-gradient-to-r from-sky-600/60 to-cyan-500/60 px-4 py-2 text-sm font-semibold text-slate-950 shadow-[0_6px_18px_rgba(56,189,248,0.26)] transition-all duration-200 hover:-translate-y-[1px] hover:shadow-[0_10px_24px_rgba(56,189,248,0.36)]"
                              >
                                Next: {nextCategory?.sectionTitle}
                                <motion.span
                                  animate={{ x: [0, 4, 0] }}
                                  transition={{
                                    repeat: Infinity,
                                    duration: 1.2,
                                  }}
                                  className="text-base"
                                >
                                  <ArrowRight className="h-4 w-4" />
                                </motion.span>
                              </button>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
