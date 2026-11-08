import React, { useEffect, useMemo, useState, useRef, useLayoutEffect } from "react";
import { reportRequestError } from "../lib/clientRequest";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useLocation } from "react-router-dom";
import homeCopy from "../lib/homeCopy";
import packageContent from "../lib/packageContent";
import { fetchHomeSectionData, HOME_SECTION_DATA_KEYS } from "../lib/homeSectionData";
import { alignToHashTarget, getCssHeaderOffsetPx } from "../lib/scrollCoordinator";
import { scrollWindowTo } from "../lib/scrollWindowTo";


const slugify = (text = "") =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "faq-item";

const UPGRADE_HASH = "upgrade-path";
const TRUST_HASH = "trust";
const QUESTIONS_PER_PAGE = 10;
const { HOME_COPY } = homeCopy;
const { normalizeFaqQuestions } = packageContent;
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

const isFaqIntentHash = (hash = "") =>
  hash === "faq" || hash === UPGRADE_HASH || hash === TRUST_HASH;

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

const FAQ_ANSWER_CLASS = "pb-5 pr-10 text-[15px] leading-relaxed text-ink-secondary sm:text-base";
const FAQ_PAGE_LAYOUT_CLASS = "lg:grid lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start lg:gap-x-16";
const FAQ_PAGE_QUESTIONS_CLASS = "lg:col-start-2 lg:row-start-1 lg:mt-0 lg:max-w-none";

export default function FaqSection({
  compact = false,
  headingTag = "h2",
  initialFaqCopy = null,
  initialQuestions = null,
  onPaginationStart,
}) {
  const Heading = headingTag;
  const location = useLocation();
  const [activeHash, setActiveHash] = useState(() =>
    (location.hash || "").replace(/^#/, "")
  );
  const [faqCopy, setFaqCopy] = useState(() => initialFaqCopy);
  const [openQuestions, setOpenQuestions] = useState({});
  const [questions, setQuestions] = useState(() =>
    initialQuestions !== null
      ? Array.isArray(initialQuestions)
        ? normalizeFaqQuestions(initialQuestions)
        : []
      : null
  );

  useEffect(() => {
    if (initialFaqCopy !== null) {
      setFaqCopy(initialFaqCopy);
    }

    if (initialQuestions !== null) {
      setQuestions(
        Array.isArray(initialQuestions)
          ? normalizeFaqQuestions(initialQuestions)
          : []
      );
    }
  }, [initialFaqCopy, initialQuestions]);

  useEffect(() => {
    if (typeof window === "undefined") {
      setActiveHash((location.hash || "").replace(/^#/, ""));
      return undefined;
    }

    const syncHashFromWindow = () => {
      pendingPageScrollRef.current = null;
      const nextHash = (
        window.location.hash ||
        location.hash ||
        ""
      ).replace(/^#/, "");
      setActiveHash((prev) => (prev === nextHash ? prev : nextHash));
    };

    const syncHashFromIntent = (event) => {
      pendingPageScrollRef.current = null;
      const nextHash = String(
        event?.detail?.hash || window.location.hash || location.hash || ""
      ).replace(/^#/, "");
      setActiveHash((prev) => (prev === nextHash ? prev : nextHash));
    };

    syncHashFromWindow();
    window.addEventListener("hashchange", syncHashFromWindow);
    window.addEventListener("roo:pending-section-target", syncHashFromIntent);

    return () => {
      window.removeEventListener("hashchange", syncHashFromWindow);
      window.removeEventListener(
        "roo:pending-section-target",
        syncHashFromIntent
      );
    };
  }, [location.hash]);
  
  const [[page, direction], setPage] = useState([0, 0]);
  const pendingPageScrollRef = useRef(null);

  const [containerRef, { height }] = useElementSize();

  const toggleQuestion = (questionId) => {
    setOpenQuestions((prev) => ({
      ...prev,
      [questionId]: !prev[questionId],
    }));
  };

  useEffect(() => {
    if (faqCopy !== null) return;
    fetchHomeSectionData(HOME_SECTION_DATA_KEYS.faqSettings)
      .then(setFaqCopy)
      .catch(reportRequestError);
  }, [faqCopy]);

  useEffect(() => {
    if (questions !== null) return;
    fetchHomeSectionData(HOME_SECTION_DATA_KEYS.faqQuestions)
      .then((res) =>
        setQuestions(normalizeFaqQuestions(Array.isArray(res) ? res : []))
      )
      .catch(reportRequestError);
  }, [questions]);

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

  const questionsPerPage = compact ? QUESTIONS_PER_PAGE : Math.max(flatQuestions.length, 1);
  const totalPages = Math.ceil(flatQuestions.length / questionsPerPage);
  const safePage = Math.min(Math.max(0, page), Math.max(0, totalPages - 1));

  const pagedQuestions = useMemo(() => {
    const start = safePage * questionsPerPage;
    return flatQuestions.slice(start, start + questionsPerPage);
  }, [flatQuestions, questionsPerPage, safePage]);

  const paginate = (newDirection) => {
    const newPage = safePage + newDirection;
    if (newPage >= 0 && newPage < totalPages) {
      onPaginationStart?.();
      pendingPageScrollRef.current = newPage;
      setPage([newPage, newDirection]);
    }
  };

  const finishPageChange = (animation) => {
    if (animation !== "center" || pendingPageScrollRef.current !== safePage) return;
    pendingPageScrollRef.current = null;
    const faq = document.getElementById("faq");
    if (faq) scrollWindowTo(faq.getBoundingClientRect().top + window.scrollY - 96);
  };

  const isLoading = questions === null;

  useEffect(() => {
    if (!flatQuestions.length) return;
    const hash = activeHash;
    if (!hash) return;
    if (!isFaqIntentHash(hash) && !flatQuestions.some((q) => q.id === hash)) {
      return;
    }

    if (hash === "faq") {
      return;
    }

    const questionIndex = flatQuestions.findIndex((q) => q.id === hash);
    if (questionIndex >= 0) {
      const targetPage = Math.floor(questionIndex / questionsPerPage);
      if (targetPage !== safePage) {
        const dir = targetPage > safePage ? 1 : -1;
        pendingPageScrollRef.current = null;
        setPage([targetPage, dir]);
      }
      setOpenQuestions((prev) => ({ ...prev, [hash]: true }));
      return alignToHashTarget({
        hash: `#${hash}`,
        behavior: "auto",
        getOffsetPx: () => getCssHeaderOffsetPx(96),
        stableFramesRequired: 4,
        preAlignStableFramesRequired: 1,
        minRuntimeMs: 180,
        maxWaitMs: 5000,
      });
    }
  }, [activeHash, flatQuestions, questionsPerPage, safePage]);

  const eyebrowText = faqCopy?.eyebrow || HOME_COPY.faqSettings.eyebrow;
  const headingText = faqCopy?.title || HOME_COPY.faqSettings.title;
  const subtitleText = faqCopy?.subtitle || HOME_COPY.faqSettings.subtitle;
  const sectionPaddingClass = compact ? "pt-20 pb-10" : "page-top pb-24";
  const sectionId = compact ? undefined : "faq";

  return (
    <>
    <section
      id={sectionId}
      className={`relative z-10 scroll-mt-32 ${sectionPaddingClass} px-4 sm:px-6 text-ink`}
    >
      <div className={`relative max-w-6xl mx-auto ${compact ? "" : FAQ_PAGE_LAYOUT_CLASS}`}>
        <div className={compact ? "text-center" : "text-center lg:text-left"}>
          <p className="text-sm font-semibold text-ink-secondary">
            {eyebrowText}
          </p>
          <Heading className="ri-faq-heading section-title mt-3">
            {headingText}
          </Heading>
          <p className="section-lede">
            {subtitleText}
          </p>
        </div>

        <div className={`ri-faq-questions mx-auto mt-12 w-full max-w-3xl ${compact ? "" : FAQ_PAGE_QUESTIONS_CLASS}`}>
          {isLoading && (
            <div className="rounded-2xl border border-line-input bg-skeleton p-6 animate-pulse">
              <div className="h-4 w-24 rounded-full bg-surface-hover-accent" />
              <div className="mt-3 space-y-2">
                <div className="h-3 w-full rounded bg-surface-hover-accent" />
                <div className="h-3 w-5/6 rounded bg-surface-hover-accent" />
              </div>
            </div>
          )}

          <motion.div
            animate={{ height: compact ? height || "auto" : "auto" }}
            transition={{ type: "spring", stiffness: 180, damping: 20 }}
            className="relative overflow-hidden"
          >
            <div ref={containerRef}>
              <AnimatePresence initial={false} mode="wait" custom={direction}>
                <motion.div
                  key={safePage}
                  custom={direction}
                  variants={variants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  onAnimationComplete={finishPageChange}
                  transition={{
                    x: { type: "spring", stiffness: 300, damping: 30 },
                    opacity: { duration: 0.2 },
                  }}
                  className="space-y-3 py-2" // py-2 prevents margin collapse issues
                >
                  {pagedQuestions.map((q) => {
                    const isAnswerOpen = openQuestions[q.id] || false;
                    const answerId = `${q.id}-answer`;

                    return (
                      <motion.div
                        layout="position"
                        key={q.key}
                        id={q.id}
                        className="ri-faq-question rounded-xl border border-line-input bg-surface-card px-5 sm:px-6 transition-colors duration-200 hover:border-line-accent"
                      >
                        <button
                          type="button"
                          onClick={() => toggleQuestion(q.id)}
                          className="flex min-h-14 w-full items-center justify-between gap-4 py-4 text-left"
                          aria-expanded={isAnswerOpen}
                          aria-controls={answerId}
                        >
                          <div className="flex-1 text-base font-semibold leading-snug text-ink sm:text-[17px]">
                            {q.question}
                          </div>
                          <motion.span
                            animate={{ rotate: isAnswerOpen ? 180 : 0 }}
                            transition={{ duration: 0.2 }}
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-hover text-ink-secondary"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </motion.span>
                        </button>

                        <div id={answerId}>
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
                                <div className={FAQ_ANSWER_CLASS}>
                                  {q.answer}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                          {!isAnswerOpen && (
                            <div hidden className={FAQ_ANSWER_CLASS}>
                              {q.answer}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}

                  {!isLoading && flatQuestions.length === 0 && (
                    <div className="text-ink-secondary text-sm">
                      No questions added yet.
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>

          {totalPages > 1 && (
            <div className="pt-6 flex items-center justify-center gap-2 sm:gap-3 text-sm text-ink-secondary">
              <button
                type="button"
                onClick={() => paginate(-1)}
                disabled={safePage <= 0}
                className="w-24 sm:w-28 shrink-0 rounded-full border border-line-input bg-surface-card px-3 sm:px-4 py-2 font-semibold text-ink text-center transition hover:border-line-accent disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
              >
                Previous
              </button>
              <span className="min-w-[96px] sm:min-w-[110px] text-center text-ink-secondary font-medium">
                Page {safePage + 1} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => paginate(1)}
                disabled={safePage >= totalPages - 1}
                className="w-24 sm:w-28 shrink-0 rounded-full border border-line-input bg-surface-card px-3 sm:px-4 py-2 font-semibold text-ink text-center transition hover:border-line-accent disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
    </>
  );
}
