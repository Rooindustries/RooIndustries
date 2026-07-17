"use client";

import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useLowPerformanceMode } from "../lib/performanceMode";

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

export default function SiteDialog({
  ariaDescribedBy,
  ariaLabelledBy,
  children,
  className = "",
  closeLabel = "Close",
  dismissible = true,
  onClose,
  open,
}) {
  const closeButtonRef = useRef(null);
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const scrollLockRef = useRef(null);
  const lowPerformanceMode = useLowPerformanceMode();

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement;
    const focusTarget = dismissible
      ? closeButtonRef.current
      : dialogRef.current?.querySelector("[data-autofocus], button, input");
    (focusTarget || dialogRef.current)?.focus();
    const handleKeyDown = (event) => {
      if (dismissible && event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [dismissible, onClose, open]);

  useEffect(() => {
    if (!open) return undefined;
    const body = document.body;
    const html = document.documentElement;
    const original = {
      htmlOverflow: html.style.overflow,
      overflow: body.style.overflow,
      scrollY: window.scrollY,
    };
    scrollLockRef.current = original;
    body.classList.add("is-modal-open", "is-modal-blur");
    body.style.overflow = "hidden";
    html.style.overflow = "hidden";
    return () => {
      const stored = scrollLockRef.current || original;
      body.classList.remove("is-modal-open", "is-modal-blur");
      body.style.overflow = stored.overflow || "";
      html.style.overflow = stored.htmlOverflow || "";
      window.scrollTo(0, stored.scrollY || 0);
    };
  }, [open]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          animate="visible"
          className="glass-overlay low-perf-overlay fixed inset-0 z-[100] flex items-center justify-center px-4"
          exit="exit"
          initial="hidden"
          onClick={dismissible ? onClose : undefined}
          variants={overlayVariants}
        >
          <motion.div
            animate="visible"
            aria-describedby={ariaDescribedBy}
            aria-labelledby={ariaLabelledBy}
            aria-modal="true"
            className={`low-perf-surface glass-premium glass-card-surface relative w-full max-w-md rounded-2xl border border-info-border p-6 text-center transition-all duration-500 ease-in-out hover:shadow-glow-strong ${className}`}
            exit="exit"
            initial="hidden"
            onClick={(event) => event.stopPropagation()}
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
            variants={
              lowPerformanceMode
                ? {
                    hidden: { opacity: 0, y: 6 },
                    visible: {
                      opacity: 1,
                      y: 0,
                      transition: { duration: 0.16, ease: "easeOut" },
                    },
                    exit: {
                      opacity: 0,
                      y: 6,
                      transition: { duration: 0.12, ease: "easeIn" },
                    },
                  }
                : modalContainerVariants
            }
          >
            {dismissible ? (
              <button
                aria-label={closeLabel}
                className="absolute right-3 top-3 z-10 text-2xl text-info-text transition hover:text-white"
                onClick={onClose}
                ref={closeButtonRef}
                type="button"
              >
                <span aria-hidden="true">&times;</span>
              </button>
            ) : null}
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  );
}
