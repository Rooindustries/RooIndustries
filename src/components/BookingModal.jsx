import React, { useCallback, useEffect, useRef, useState, useLayoutEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BookingDialogHoldContext, BookingDialogReadyContext } from "../lib/bookingDialogHold";
import { useLowPerformanceMode } from "../lib/performanceMode";
import { isTopDialog, useDialogFocus } from "../lib/useDialogFocus";
import { setVisibleTimeout } from "../lib/visibleTimeout";

export default function BookingModal({ open, onClose, children, skipInitialSizeAnimation = false, contentKey }) {
  const contentRef = useRef(null);
  // Focus trapping and outside-click detection need the unscaled dialog boundary, including the close button.
  const wrapperRef = useRef(null);
  const closeButtonRef = useRef(null);
  const stageRef = useRef(null);
  const bodyRef = useRef(null);
  const [introComplete, setIntroComplete] = useState(skipInitialSizeAnimation);
  const lastLayoutRef = useRef({
    wrapperWidth: 0,
    wrapperHeight: 0,
  });
  const lowPerformanceMode = useLowPerformanceMode();
  const [viewport, setViewport] = useState(null);
  const [wrapperSize, setWrapperSize] = useState({ width: 0, height: 0 });
  const [contentSwitch, setContentSwitch] = useState({ contentKey, revealPending: false });
  const restoreFocusRef = useRef(true);
  const lastFocusedInDialogRef = useRef(null);
  if (contentSwitch.contentKey !== contentKey) {
    setContentSwitch({ contentKey, revealPending: open });
  }
  const [awaitingContent, setAwaitingContent] = useState(skipInitialSizeAnimation);
  const [contentHydrated, setContentHydrated] = useState(false);
  const markContentHydrated = useCallback(() => setContentHydrated(true), []);
  const [holdCount, setHoldCount] = useState(0);
  const holdCountRef = useRef(0);
  const contentRevealed = !awaitingContent && !contentSwitch.revealPending;

  const revealFocusedControl = useCallback((target) => {
    const body = bodyRef.current;
    if (!body?.contains(target) || target === body) return;
    const viewport = body.getBoundingClientRect();
    if (!viewport.height) return;
    const control = target.getBoundingClientRect();
    const actions = body.querySelector(".booking-step-actions");
    if (actions?.contains(target)) return;
    const bottom = Math.min(viewport.bottom, actions?.getBoundingClientRect().top ?? viewport.bottom);
    const descriptions = (target.getAttribute("aria-describedby") || "").split(/\s+/)
      .map(id => document.getElementById(id))
      .filter(node => node && body.contains(node))
      .map(node => node.getBoundingClientRect());
    const controlBottom = Math.max(control.bottom, ...descriptions.map(rect => rect.bottom));
    if (control.top < viewport.top + 8) {
      body.scrollTop -= viewport.top + 8 - control.top;
    } else if (controlBottom > bottom - 8) {
      body.scrollTop += controlBottom - bottom + 8;
    }
  }, []);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!open || !body) return undefined;
    let actions = null;
    const updateHeight = () => {
      body.style.setProperty("--booking-actions-height", `${actions?.offsetHeight || 0}px`);
      revealFocusedControl(document.activeElement);
    };
    const resizeObserver = new ResizeObserver(updateHeight);
    const observeActions = () => {
      const nextActions = body.querySelector(".booking-step-actions");
      if (nextActions !== actions) {
        resizeObserver.disconnect();
        actions = nextActions;
        if (actions) resizeObserver.observe(actions);
      }
      updateHeight();
    };
    const observer = new MutationObserver(observeActions);
    observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-describedby"] });
    observeActions();
    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
    };
  }, [open, revealFocusedControl]);

  const CONTENT_REVEAL_FALLBACK_MS = 300;
  const CONTENT_READY_MAX_WAIT_MS = 1500;

  const hold = useCallback(() => {
    let released = false;
    holdCountRef.current += 1;
    setHoldCount(holdCountRef.current);
    return () => {
      if (released) return;
      released = true;
      holdCountRef.current -= 1;
      setHoldCount(holdCountRef.current);
    };
  }, []);

  const stopAwaitingContent = useCallback(() => {
    setAwaitingContent(false);
    setContentSwitch((current) => ({ ...current, revealPending: true }));
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const calculateLayout = () => {
      const visual = window.visualViewport;
      const width = Math.min(document.documentElement.clientWidth || window.innerWidth, visual?.width || window.innerWidth);
      const height = visual?.height || window.innerHeight;
      const style = getComputedStyle(stageRef.current);
      const nextLayout = {
        wrapperWidth: Math.min(960, width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        wrapperHeight: Math.max(0, height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)),
      };
      lastLayoutRef.current = nextLayout;
      setWrapperSize({ width: nextLayout.wrapperWidth, height: nextLayout.wrapperHeight });
      setViewport({ width, height, top: visual?.offsetTop || 0, left: visual?.offsetLeft || 0 });
    };
    calculateLayout();
    window.addEventListener("resize", calculateLayout);
    window.visualViewport?.addEventListener("resize", calculateLayout);
    window.visualViewport?.addEventListener("scroll", calculateLayout);
    return () => {
      window.removeEventListener("resize", calculateLayout);
      window.visualViewport?.removeEventListener("resize", calculateLayout);
      window.visualViewport?.removeEventListener("scroll", calculateLayout);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [contentKey]);

  useLayoutEffect(() => {
    if (!awaitingContent) return undefined;
    return setVisibleTimeout(stopAwaitingContent, CONTENT_READY_MAX_WAIT_MS);
  }, [awaitingContent, stopAwaitingContent]);

  useLayoutEffect(() => {
    if (!awaitingContent || !contentHydrated || holdCount > 0) return undefined;
    return setVisibleTimeout(() => {
      if (holdCountRef.current === 0) stopAwaitingContent();
    }, 0);
  }, [awaitingContent, contentHydrated, holdCount, stopAwaitingContent]);

  useLayoutEffect(() => {
    if (!contentSwitch.revealPending) return undefined;
    const reveal = () =>
      setContentSwitch((current) =>
        current === contentSwitch ? { ...current, revealPending: false } : current
      );
    if (!open) {
      reveal();
      return undefined;
    }

    let frame = 0;
    const revealWhenLayoutApplied = () => {
      const wrapper = wrapperRef.current?.getBoundingClientRect();
      const content = contentRef.current?.getBoundingClientRect();
      const { wrapperWidth, wrapperHeight } = lastLayoutRef.current;
      const layoutApplied =
        wrapper &&
        content &&
        wrapperHeight > 0 &&
        Math.abs(wrapper.width - wrapperWidth) < 1 &&
        Math.abs(wrapper.height - wrapperHeight) < 1 &&
        Math.abs(content.width - wrapperWidth) < 1 &&
        Math.abs(content.height - wrapperHeight) < 1;
      if (layoutApplied) {
        reveal();
        return;
      }
      frame = window.requestAnimationFrame(revealWhenLayoutApplied);
    };
    frame = window.requestAnimationFrame(revealWhenLayoutApplied);
    const cancelFallback = setVisibleTimeout(reveal, CONTENT_REVEAL_FALLBACK_MS);

    return () => {
      window.cancelAnimationFrame(frame);
      cancelFallback();
    };
  }, [contentSwitch, open]);

  useLayoutEffect(() => {
    if (contentSwitch.revealPending) {
      restoreFocusRef.current = true;
      return;
    }
    if (!restoreFocusRef.current || !introComplete || !contentRevealed || !wrapperRef.current) return;
    restoreFocusRef.current = false;
    if (!open || !isTopDialog(wrapperRef)) return;
    if (wrapperRef.current?.contains(document.activeElement)) return;
    closeButtonRef.current?.focus();
  }, [contentSwitch, open, introComplete, contentRevealed]);

  useLayoutEffect(() => {
    const trackFocus = (event) => {
      lastFocusedInDialogRef.current = wrapperRef.current?.contains(event.target) ? event.target : null;
    };
    document.addEventListener("focusin", trackFocus);
    return () => document.removeEventListener("focusin", trackFocus);
  }, []);

  useEffect(() => {
    if (!open || !contentRevealed) return;
    if (!lastFocusedInDialogRef.current || lastFocusedInDialogRef.current.isConnected) return;
    if (document.activeElement !== document.body || !isTopDialog(wrapperRef)) return;
    closeButtonRef.current?.focus({ preventScroll: true });
    lastFocusedInDialogRef.current = null;
  });

  useEffect(() => {
    if (!open) return;
    const originalStyleBody = window.getComputedStyle(document.body).overflow;
    const originalStyleHtml = window.getComputedStyle(document.documentElement).overflow;
    
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    
    return () => {
      document.body.style.overflow = originalStyleBody;
      document.documentElement.style.overflow = originalStyleHtml;
    };
  }, [open]);

  useDialogFocus({ open, dialogRef: wrapperRef, initialFocusRef: closeButtonRef, onClose });

  const fadeTransition = {
    duration: lowPerformanceMode ? 0.16 : 0.35,
    ease: [0.4, 0, 0.2, 1],
  };

  const handleGlobalClick = (e) => {
    if (!contentRevealed || !isTopDialog(wrapperRef)) return;
    const dialogRoot = wrapperRef.current || contentRef.current;
    if (dialogRoot && dialogRoot.contains(e.target)) {
      return;
    }
    onClose?.();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={stageRef}
          className="booking-dialog-stage fixed z-[70] flex items-center justify-center overflow-hidden"
          style={viewport || { inset: 0 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeTransition}
          onClick={handleGlobalClick}
        >
          <div
            className="booking-modal-overlay glass-overlay low-perf-overlay fixed inset-0"
            style={{ pointerEvents: "none" }}
          />
          <motion.div
            ref={wrapperRef}
            role="dialog"
            aria-modal="true"
            aria-label="Schedule your session"
            className={`ri-booking booking-dialog-frame relative overflow-hidden rounded-2xl bg-panel shadow-glow-strong ring-1 ring-line-input${contentRevealed ? "" : " invisible"}`}
            initial={false}
            style={{ "--booking-intro-offset": skipInitialSizeAnimation ? "0px" : "16px" }}
            animate={wrapperSize.width > 0 ? { width: wrapperSize.width, height: wrapperSize.height } : {}}
            transition={{ duration: introComplete ? 0 : 0.16, ease: [0.2, 0, 0, 1] }}
            onAnimationComplete={() => {
              setIntroComplete(true);
              revealFocusedControl(document.activeElement);
            }}
          >
            <button
              id="booking-modal-close"
              aria-label="Close"
              className="absolute right-2 top-2 z-50 flex h-11 w-11 items-center justify-center rounded-lg text-info-text hover:text-white text-3xl leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info-border"
              ref={closeButtonRef}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
            <div
              data-booking-scaler="true"
              className="absolute left-0 top-0 cursor-default"
              style={{ width: wrapperSize.width || "100%", height: wrapperSize.height || "100%" }}
            >
              <div ref={contentRef} className="booking-dialog-viewport">
                <div aria-hidden="true" />
                <div
                  ref={bodyRef}
                  className={`booking-dialog-body${introComplete ? "" : " invisible"}`}
                  role="region"
                  aria-label="Booking details"
                  onFocusCapture={(event) => revealFocusedControl(event.target)}
                >
                  <BookingDialogReadyContext.Provider value={markContentHydrated}>
                    <BookingDialogHoldContext.Provider value={hold}>
                      {children}
                    </BookingDialogHoldContext.Provider>
                  </BookingDialogReadyContext.Provider>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
