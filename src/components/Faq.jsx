import React, { useEffect, useMemo, useState, useRef, useLayoutEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useLocation } from "react-router-dom";
import { client } from "../sanityClient";

// --- HELPERS ---

const slugify = (text = "") =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "faq-item";

const UPGRADE_HASH = "upgrade-path";
const TRUST_HASH = "trust";
const QUESTIONS_PER_PAGE = 10;
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

// --- CUSTOM HOOK FOR AUTO-HEIGHT ANIMATION ---
// This allows us to animate height without installing extra libraries like react-use-measure
function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    if (!ref.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

// --- ANIMATION VARIANTS ---
const variants = {
  enter: (direction) => ({
    x: direction > 0 ? 30 : -30,
    opacity: 0,
    filter: "blur(4px)",
  }),
  center: {
    zIndex: 1,
    x: 0,
    opacity: 1,
    filter: "blur(0px)",
  },
  exit: (direction) => ({
    zIndex: 0,
    x: direction < 0 ? 30 : -30,
    opacity: 0,
    filter: "blur(4px)",
  }),
};

export default function FaqSection({ compact = false }) {
  const location = useLocation();
  const [faqCopy, setFaqCopy] = useState(null);
  const [openQuestions, setOpenQuestions] = useState({});
  const [questions, setQuestions] = useState(null);
  
  // Pagination State
  const [[page, direction], setPage] = useState([0, 0]);

  // Height Measurement for smooth container resizing
  const [containerRef, { height }] = useElementSize();

  const scrollWithOffset = (id, behavior = "smooth") => {
    const el = typeof id === "string" ? document.getElementById(id) : id;
    if (!el) return false;
    const yOffset = -96;
    const y = el.getBoundingClientRect().top + window.scrollY + yOffset;
    window.scrollTo({ top: y, behavior });
    return true;
  };

  const toggleQuestion = (questionId) => {
    setOpenQuestions((prev) => ({
      ...prev,
      [questionId]: !prev[questionId],
    }));
  };

  useEffect(() => {
    client
      .fetch(
        `*[_type == "faqSettings"][0]{ eyebrow, title, subtitle }`,
        {},
        { cache: "no-store" }
      )
      .then(setFaqCopy)
      .catch(console.error);
  }, []);

  useEffect(() => {
    client
      .fetch(
        `coalesce(
          *[_type == "faqSection" && _id == "faq"][0].questions,
          *[_type == "faqSection"] | order(_createdAt asc) .questions[]
        )`,
        {},
        { cache: "no-store" }
      )
      .then((res) => setQuestions(Array.isArray(res) ? res : []))
      .catch(console.error);
  }, []);

  const flatQuestions = useMemo(
    () =>
      (questions || []).map((q, idx) => ({
        ...q,
        id: getQuestionId(q.question, q.answer),
        key: String(idx),
        index: idx,
      })),
    [questions]
  );

  const totalPages = Math.ceil(flatQuestions.length / QUESTIONS_PER_PAGE);
  const safePage = Math.min(Math.max(0, page), Math.max(0, totalPages - 1));

  const pagedQuestions = useMemo(() => {
    const start = safePage * QUESTIONS_PER_PAGE;
    return flatQuestions.slice(start, start + QUESTIONS_PER_PAGE);
  }, [flatQuestions, safePage]);

  const paginate = (newDirection) => {
    const newPage = safePage + newDirection;
    if (newPage >= 0 && newPage < totalPages) {
      setPage([newPage, newDirection]);
      setTimeout(() => scrollWithOffset("faq"), 250);
    }
  };

  const isLoading = questions === null;

  useEffect(() => {
    if (!flatQuestions.length) return;
    const hash = (location.hash || "").replace("#", "");
    if (!hash) return;

    if (hash === "faq") {
      scrollWithOffset("faq");
      return;
    }

    const questionIndex = flatQuestions.findIndex((q) => q.id === hash);
    if (questionIndex >= 0) {
      const targetPage = Math.floor(questionIndex / QUESTIONS_PER_PAGE);
      if (targetPage !== safePage) {
        const dir = targetPage > safePage ? 1 : -1;
        setPage([targetPage, dir]);
      }
      setOpenQuestions((prev) => ({ ...prev, [hash]: true }));
      setTimeout(() => scrollWithOffset(hash), 250);
    }
  }, [location.hash, flatQuestions]); 

  const eyebrowText = faqCopy?.eyebrow || "Answers without the fluff";
  const headingText = faqCopy?.title || "Frequently Asked Questions";
  const subtitleText = faqCopy?.subtitle || "Click a question to expand its answer.";
  const sectionPaddingClass = compact ? "pt-20 pb-10" : "pt-20 pb-24";

  return (
    <section
      id="faq"
      className={`relative z-10 scroll-mt-32 ${sectionPaddingClass} px-4 sm:px-6 text-white`}
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

        <div className="mt-12">
          {isLoading && (
            <div className="rounded-2xl border border-sky-800/30 bg-slate-900/60 p-6 animate-pulse">
              <div className="h-4 w-24 rounded-full bg-sky-800/60" />
              <div className="mt-3 space-y-2">
                <div className="h-3 w-full rounded bg-sky-900/60" />
                <div className="h-3 w-5/6 rounded bg-sky-900/60" />
              </div>
            </div>
          )}

          {/* HEIGHT ANIMATION WRAPPER
            This motion.div reads the height from the hook and animates to it.
          */}
          <motion.div
            animate={{ height: height || "auto" }}
            transition={{ type: "spring", stiffness: 180, damping: 20 }}
            className="relative overflow-hidden"
          >
            {/* MEASUREMENT DIV
              The ref attaches here. ResizeObserver watches this div.
            */}
            <div ref={containerRef}>
              <AnimatePresence initial={false} mode="wait" custom={direction}>
                <motion.div
                  key={safePage}
                  custom={direction}
                  variants={variants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{
                    x: { type: "spring", stiffness: 300, damping: 30 },
                    opacity: { duration: 0.2 },
                  }}
                  className="space-y-4 py-2" // py-2 prevents margin collapse issues
                >
                  {pagedQuestions.map((q, idx) => {
                    const isAnswerOpen = openQuestions[q.id] || false;
                    const questionNumber = safePage * QUESTIONS_PER_PAGE + idx + 1;

                    return (
                      <motion.div
                        layout="position"
                        key={q.key}
                        id={q.id}
                        className="rounded-xl border border-sky-800/60 bg-slate-950/60 px-4 sm:px-5 py-3 transition-all duration-200 hover:border-cyan-300/60"
                      >
                        <button
                          type="button"
                          onClick={() => toggleQuestion(q.id)}
                          className="w-full flex items-start justify-between gap-3 text-left"
                          aria-expanded={isAnswerOpen}
                        >
                          <div className="flex-1 text-[15px] sm:text-[16px] font-semibold text-sky-50">
                            <span className="mr-2 text-sky-200/80 font-semibold">
                              {questionNumber})
                            </span>
                            {q.question}
                          </div>
                          <motion.span
                            animate={{ rotate: isAnswerOpen ? 180 : 0 }}
                            transition={{ duration: 0.2 }}
                            className="ml-2 text-cyan-200"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </motion.span>
                        </button>

                        <AnimatePresence>
                          {isAnswerOpen && (
                            <motion.div
                              key="answer"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.3, ease: "easeOut" }}
                              className="overflow-hidden"
                            >
                              <div className="pt-2 text-slate-200/90 leading-relaxed font-normal">
                                {q.answer}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    );
                  })}

                  {!isLoading && flatQuestions.length === 0 && (
                    <div className="text-slate-300/70 text-sm">
                      No questions added yet.
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="pt-6 flex items-center justify-center gap-2 sm:gap-3 text-sm text-slate-300">
              <button
                type="button"
                onClick={() => paginate(-1)}
                disabled={safePage <= 0}
                className="w-24 sm:w-28 shrink-0 rounded-full border border-sky-700/60 bg-slate-900/70 px-3 sm:px-4 py-2 font-semibold text-slate-100 text-center transition hover:border-cyan-300/60 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
              >
                Previous
              </button>
              <span className="min-w-[96px] sm:min-w-[110px] text-center text-slate-300/80 font-medium">
                Page {safePage + 1} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => paginate(1)}
                disabled={safePage >= totalPages - 1}
                className="w-24 sm:w-28 shrink-0 rounded-full border border-sky-700/60 bg-slate-900/70 px-3 sm:px-4 py-2 font-semibold text-slate-100 text-center transition hover:border-cyan-300/60 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}