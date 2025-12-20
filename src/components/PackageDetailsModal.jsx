import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.3, ease: "easeOut" },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.2, ease: "easeIn" },
  },
};

const modalContainerVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 15 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: "spring",
      damping: 25,
      stiffness: 300,
      mass: 0.8,
      staggerChildren: 0.08,
      delayChildren: 0.1,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 15,
    transition: { duration: 0.2 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 15 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 200, damping: 20 },
  },
};

export default function PackageDetailsModal({
  open,
  onClose,
  pkg,
  renderFeature,
}) {
  const scrollLockRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const body = document.body;
    const html = document.documentElement;
    const scrollY = window.scrollY;
    const original = {
      overflow: body.style.overflow,
      htmlOverflow: html.style.overflow,
      scrollY,
    };
    scrollLockRef.current = original;
    body.classList.add("is-modal-open");
    body.classList.add("is-modal-blur");
    body.style.overflow = "hidden";
    html.style.overflow = "hidden";
    return () => {
      const stored = scrollLockRef.current || original;
      body.classList.remove("is-modal-open");
      body.classList.remove("is-modal-blur");
      body.style.overflow = stored.overflow || "";
      html.style.overflow = stored.htmlOverflow || "";
      window.scrollTo(0, stored.scrollY || 0);
    };
  }, [open]);

  const rawFeatures = Array.isArray(pkg?.features) ? pkg.features : [];
  const normalizedFeatures = rawFeatures
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item.label === "string") return item.label.trim();
      if (item && typeof item.text === "string") return item.text.trim();
      if (item && typeof item.title === "string") return item.title.trim();
      return "";
    })
    .filter(Boolean);

  const fallbackChecklist = Array.isArray(pkg?.featureChecklist)
    ? pkg.featureChecklist
        .map((item) => {
          if (!item) return null;
          if (typeof item === "string") {
            return { label: item.trim(), included: true };
          }
          const label =
            typeof item.label === "string"
              ? item.label.trim()
              : typeof item.text === "string"
              ? item.text.trim()
              : typeof item.title === "string"
              ? item.title.trim()
              : "";
          if (!label) return null;
          const included =
            typeof item.included === "boolean" ? item.included : true;
          return { label, included };
        })
        .filter(Boolean)
    : [];

  const featureItems = normalizedFeatures.length
    ? normalizedFeatures.map((label) => ({ label, included: true }))
    : fallbackChecklist;
  const tagText = pkg?.tag || "Roo Industries Package";

  const handleClose = () => {
    onClose?.();
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-lg flex items-center justify-center px-4"
          variants={overlayVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          onClick={handleClose}
        >
          <motion.div
            variants={modalContainerVariants}
            className="relative w-full max-w-md bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 border border-sky-400/60 rounded-2xl shadow-[0_0_35px_rgba(56,189,248,0.4)] p-6 text-center transition-all duration-500 ease-in-out hover:shadow-[0_0_42px_rgba(56,189,248,0.5)]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <motion.button
              aria-label="Close"
              variants={itemVariants}
              className="absolute right-3 top-3 text-sky-200 hover:text-white transition text-2xl z-10"
              onClick={handleClose}
            >
              &times;
            </motion.button>

            <motion.div variants={itemVariants}>
              <div className="inline-flex items-center px-4 py-1.5 rounded-full text-xs font-semibold text-white bg-[#1fa7ff] shadow-[0_0_18px_rgba(31,167,255,0.6)] mb-4">
                {tagText}
              </div>
            </motion.div>

            <motion.h3
              variants={itemVariants}
              className="text-2xl font-bold text-sky-100"
            >
              {pkg?.title}
            </motion.h3>

            <motion.p
              variants={itemVariants}
              className="text-4xl font-bold text-sky-300 mt-2"
            >
              {pkg?.price}
            </motion.p>

            <motion.ul className="mt-4 space-y-2 text-sm text-sky-100 text-left">
              {featureItems.map((item, i) => (
                <motion.li
                  key={`${item.label}-${i}`}
                  variants={itemVariants}
                  className={`flex items-start gap-2 ${
                    item.included === false ? "opacity-40" : ""
                  }`}
                >
                  <span className="text-sky-400 mt-1">&#10004;</span>
                  <span className="flex-1">
                    {renderFeature ? renderFeature(item.label) : item.label}
                  </span>
                </motion.li>
              ))}
            </motion.ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
