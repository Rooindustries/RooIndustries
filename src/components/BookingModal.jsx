import { useCallback, useEffect, useRef, useState, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { BookingDialogHoldContext, BookingDialogReadyContext } from "../lib/bookingDialogHold";
import { useLowPerformanceMode } from "../lib/performanceMode";
import { isTopDialog, useDialogFocus } from "../lib/useDialogFocus";
import { setVisibleTimeout } from "../lib/visibleTimeout";

const MOBILE_BREAKPOINT = 780;
const MOBILE_BASE_WIDTH = 550;
const DESKTOP_BASE_WIDTH = 1150;
const MOBILE_PADDING_Y = 80;
const DESKTOP_PADDING_Y = 16;
const DESKTOP_SCALE_BOOST = 1.03;
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.2;
const CLOSE_ROW_HEIGHT = 48;
const CONTENT_REVEAL_FALLBACK_MS = 300;
const CONTENT_READY_MAX_WAIT_MS = 1500;

export default function BookingModal({ open, onClose, children, skipInitialSizeAnimation = false, contentKey, routePath, reservationRef }) {
  const contentRef = useRef(null);
  const wrapperRef = useRef(null);
  const closeButtonRef = useRef(null);
  const stageRef = useRef(null);
  const layoutFrameRef = useRef(0);
  const laidOutRef = useRef(false);
  const sizeTransitionEnabledRef = useRef(!skipInitialSizeAnimation);
  const lastLayoutRef = useRef({
    scale: 1,
    mobile: false,
    renderWidth: DESKTOP_BASE_WIDTH,
    wrapperWidth: 0,
    wrapperHeight: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    viewportTop: 0,
  });
  const lowPerformanceMode = useLowPerformanceMode();
  const [dynamicScale, setDynamicScale] = useState(1);
  const [isMobile, setIsMobile] = useState(false);
  const [renderWidth, setRenderWidth] = useState(DESKTOP_BASE_WIDTH);
  const [wrapperSize, setWrapperSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState(null);
  const [layoutInstant, setLayoutInstant] = useState(false);
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
    const stage = stageRef.current;
    if (!stage?.contains(target) || target === stage) return;
    const view = stage.getBoundingClientRect();
    const visual = window.visualViewport;
    const top = Math.max(view.top, visual ? visual.offsetTop : view.top);
    const bottom = Math.min(view.bottom, visual ? visual.offsetTop + visual.height : view.bottom);
    if (bottom <= top) return;
    const control = target.getBoundingClientRect();
    const descriptions = (target.getAttribute("aria-describedby") || "").split(/\s+/)
      .map(id => document.getElementById(id))
      .filter(node => node && stage.contains(node))
      .map(node => node.getBoundingClientRect());
    const controlBottom = Math.max(control.bottom, ...descriptions.map(rect => rect.bottom));
    const available = bottom - top;
    const span = controlBottom - control.top;
    const margin = Math.max(0, Math.min(8, (available - span) / 2));
    if (control.top < top + margin || span > available) {
      stage.scrollTop -= top + margin - control.top;
    } else if (controlBottom > bottom - margin) {
      stage.scrollTop += controlBottom - bottom + margin;
    }
  }, []);

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
    if (!open) {
      laidOutRef.current = false;
      return undefined;
    }
    const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);

    const calculateLayout = () => {
      const visual = window.visualViewport;
      const width = document.documentElement.clientWidth || window.innerWidth;
      const height = visual?.height || window.innerHeight;
      const top = visual?.offsetTop || 0;
      const currentIsMobile = mobileQuery.matches || width < MOBILE_BREAKPOINT;
      const baseWidth = currentIsMobile ? Math.max(width, MOBILE_BASE_WIDTH) : DESKTOP_BASE_WIDTH;
      if (contentRef.current && contentRef.current.offsetWidth !== baseWidth) {
        contentRef.current.style.width = `${baseWidth}px`;
      }
      const contentHeight = contentRef.current?.offsetHeight || 0;

      let scale = 1;

      if (currentIsMobile) {
        scale = Math.min(width / baseWidth, 1);
      } else {
        const widthScale = ((width * 0.95) / baseWidth) * DESKTOP_SCALE_BOOST;
        const heightScale = contentHeight ? (height - DESKTOP_PADDING_Y - CLOSE_ROW_HEIGHT) / contentHeight : MAX_SCALE;
        scale = Math.min(widthScale, heightScale);
      }

      scale = Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);

      const nextLayout = {
        scale,
        mobile: currentIsMobile,
        renderWidth: baseWidth,
        wrapperWidth: contentRef.current ? baseWidth * scale : 0,
        wrapperHeight: contentHeight ? CLOSE_ROW_HEIGHT + contentHeight * scale : 0,
        viewportWidth: width,
        viewportHeight: height,
        viewportTop: top,
      };
      const prevLayout = lastLayoutRef.current;
      const viewportChanged = laidOutRef.current && (
        prevLayout.mobile !== nextLayout.mobile ||
        Math.abs(prevLayout.renderWidth - nextLayout.renderWidth) >= 1 ||
        prevLayout.viewportWidth !== nextLayout.viewportWidth ||
        prevLayout.viewportHeight !== nextLayout.viewportHeight ||
        prevLayout.viewportTop !== nextLayout.viewportTop);
      const changed =
        viewportChanged ||
        Math.abs(prevLayout.scale - nextLayout.scale) > 0.005 ||
        Math.abs(prevLayout.wrapperWidth - nextLayout.wrapperWidth) >= 1 ||
        Math.abs(prevLayout.wrapperHeight - nextLayout.wrapperHeight) >= 1;

      if (!changed) return;

      lastLayoutRef.current = nextLayout;
      laidOutRef.current = nextLayout.wrapperWidth > 0 && nextLayout.wrapperHeight > 0;
      setLayoutInstant(viewportChanged);
      setIsMobile(currentIsMobile);
      setDynamicScale(nextLayout.scale);
      setRenderWidth(nextLayout.renderWidth);
      setWrapperSize({ width: nextLayout.wrapperWidth, height: nextLayout.wrapperHeight });
      setViewport({ top, left: 0, width, height });
    };

    const scheduleLayout = () => {
      window.cancelAnimationFrame(layoutFrameRef.current);
      layoutFrameRef.current = window.requestAnimationFrame(calculateLayout);
    };

    const applyViewport = () => {
      window.cancelAnimationFrame(layoutFrameRef.current);
      flushSync(calculateLayout);
    };

    calculateLayout();
    window.addEventListener("resize", applyViewport);
    window.visualViewport?.addEventListener("resize", applyViewport);
    window.visualViewport?.addEventListener("scroll", applyViewport);
    const observer = new ResizeObserver(scheduleLayout);
    if (contentRef.current) observer.observe(contentRef.current);

    return () => {
      window.removeEventListener("resize", applyViewport);
      window.visualViewport?.removeEventListener("resize", applyViewport);
      window.visualViewport?.removeEventListener("scroll", applyViewport);
      window.cancelAnimationFrame(layoutFrameRef.current);
      layoutFrameRef.current = 0;
      observer.disconnect();
    };
  }, [children, open, contentKey]);

  useLayoutEffect(() => {
    if (open && viewport) revealFocusedControl(document.activeElement);
  }, [open, viewport, revealFocusedControl]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!open || !stage) return undefined;
    const observer = new MutationObserver((mutations) => {
      if (mutations.some(mutation => mutation.target === document.activeElement)) {
        revealFocusedControl(document.activeElement);
      }
    });
    observer.observe(stage, { subtree: true, attributes: true, attributeFilter: ["aria-describedby"] });
    return () => observer.disconnect();
  }, [open, revealFocusedControl]);

  useLayoutEffect(() => {
    const reservation = contentRef.current?.querySelector("[data-booking-reservation]");
    if (!open || !reservation) return undefined;
    if (routePath !== "/payment") {
      reservation.style.removeProperty("min-height");
      return undefined;
    }
    let card = null;
    const keepHeight = () => {
      if (!card) return;
      const style = getComputedStyle(card);
      reservation.style.minHeight = `${card.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom)}px`;
    };
    const resizeObserver = new ResizeObserver(keepHeight);
    const trackCard = () => {
      const next = reservation.firstElementChild;
      if (next === card) return;
      resizeObserver.disconnect();
      card = next;
      if (card) resizeObserver.observe(card);
      keepHeight();
    };
    const observer = new MutationObserver(trackCard);
    observer.observe(reservation, { childList: true });
    trackCard();
    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
    };
  }, [open, routePath]);

  useLayoutEffect(() => {
    if (stageRef.current) stageRef.current.scrollTop = 0;
  }, [contentKey, routePath]);

  useLayoutEffect(() => {
    if (sizeTransitionEnabledRef.current) return undefined;
    const frame = window.requestAnimationFrame(() => {
      sizeTransitionEnabledRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

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
        Math.abs(content.height + CLOSE_ROW_HEIGHT - wrapperHeight) < 1;
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
    if (!restoreFocusRef.current || !contentRevealed || !wrapperRef.current) return;
    restoreFocusRef.current = false;
    if (!open || !isTopDialog(wrapperRef)) return;
    if (wrapperRef.current?.contains(document.activeElement)) return;
    closeButtonRef.current?.focus();
  }, [contentSwitch, open, contentRevealed]);

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

  const springTransition = lowPerformanceMode
    ? { duration: 0.16, ease: [0.2, 0, 0, 1] }
    : { type: "spring", stiffness: 260, damping: 30, mass: 1 };

  const fadeTransition = {
    duration: lowPerformanceMode ? 0.16 : 0.35,
    ease: [0.4, 0, 0.2, 1],
  };

  const scalerTransition = lowPerformanceMode ? fadeTransition : springTransition;
  const sizeTransition = contentRevealed && sizeTransitionEnabledRef.current && !layoutInstant ? springTransition : { duration: 0 };

  const handleGlobalClick = (e) => {
    if (!contentRevealed || !isTopDialog(wrapperRef)) return;
    const dialogRoot = wrapperRef.current || contentRef.current;
    if (dialogRoot && dialogRoot.contains(e.target)) {
      return;
    }
    onClose?.();
  };

  const paddingBlockValue = (isMobile ? MOBILE_PADDING_Y : DESKTOP_PADDING_Y) / 2;
  const paddingTopValue = Math.max(0, paddingBlockValue - (isMobile ? CLOSE_ROW_HEIGHT : 0));

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={stageRef}
          className="booking-dialog-stage fixed z-[70] overflow-y-auto overflow-x-hidden"
          style={viewport || { inset: 0 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeTransition}
          onClick={handleGlobalClick}
          onFocusCapture={(event) => revealFocusedControl(event.target)}
        >
          <div
            className="booking-modal-overlay glass-overlay low-perf-overlay fixed inset-0"
            style={{ pointerEvents: "none" }}
          />

          <div
            className="min-h-full w-full flex flex-col cursor-pointer"
            style={{ paddingTop: paddingTopValue, paddingBottom: paddingBlockValue }}
          >
            <motion.div
              key={contentKey}
              ref={wrapperRef}
              role="dialog"
              aria-modal="true"
              aria-label="Schedule your session"
              className={`ri-booking m-auto relative${contentRevealed ? "" : " invisible"}`}
              initial={{ width: wrapperSize.width, height: wrapperSize.height }}
              animate={{ width: wrapperSize.width, height: wrapperSize.height }}
              layout={!lowPerformanceMode}
              transition={sizeTransition}
            >
              <button
                id="booking-modal-close"
                aria-label="Close"
                className="absolute right-1 top-1 z-50 flex h-11 w-11 items-center justify-center rounded-lg text-info-text hover:text-white text-3xl leading-none opacity-80 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info-border"
                ref={closeButtonRef}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose();
                }}
              >
                <span aria-hidden="true">×</span>
              </button>

              <motion.div
                data-booking-scaler="true"
                className="shadow-none outline-none overflow-visible absolute left-0 origin-top-left cursor-default"
                style={{ top: CLOSE_ROW_HEIGHT }}
                initial={lowPerformanceMode ? { scale: dynamicScale, opacity: 0 } : { scale: dynamicScale * 0.95 }}
                animate={lowPerformanceMode ? { scale: dynamicScale, opacity: 1 } : { scale: dynamicScale }}
                exit={lowPerformanceMode ? { scale: dynamicScale, opacity: 0 } : { scale: dynamicScale * 0.95 }}
                transition={{ ...scalerTransition, scale: sizeTransition }}
              >
                <div
                  ref={contentRef}
                  className="booking-dialog-content"
                  style={{ width: renderWidth, position: "relative" }}
                >
                  <div ref={reservationRef} data-booking-reservation="true" className="mx-auto max-w-3xl px-6" />
                  <BookingDialogReadyContext.Provider value={markContentHydrated}>
                    <BookingDialogHoldContext.Provider value={hold}>
                      {children}
                    </BookingDialogHoldContext.Provider>
                  </BookingDialogReadyContext.Provider>
                </div>
              </motion.div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
