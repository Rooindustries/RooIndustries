import React, { useCallback, useEffect, useRef, useState, useLayoutEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BookingDialogHoldContext } from "../lib/bookingDialogHold";
import { useLowPerformanceMode } from "../lib/performanceMode";
import { isTopDialog, useDialogFocus } from "../lib/useDialogFocus";

const setVisibleTimeout = (callback, ms) => {
  let timer = 0;
  const start = () => {
    if (timer || document.visibilityState !== "visible") return;
    timer = window.setTimeout(callback, ms);
  };
  document.addEventListener("visibilitychange", start);
  start();
  return () => {
    document.removeEventListener("visibilitychange", start);
    window.clearTimeout(timer);
  };
};

export default function BookingModal({ open, onClose, children, skipInitialSizeAnimation = false, contentKey }) {
  const contentRef = useRef(null);
  // Focus trapping and outside-click detection need the unscaled dialog boundary, including the close button.
  const wrapperRef = useRef(null);
  const closeButtonRef = useRef(null);
  const layoutFrameRef = useRef(0);
  const sizeTransitionEnabledRef = useRef(!skipInitialSizeAnimation);
  const lastLayoutRef = useRef({
    scale: 1,
    renderWidth: 1150,
    wrapperWidth: 0,
    wrapperHeight: 0,
  });
  const lowPerformanceMode = useLowPerformanceMode();
  const [dynamicScale, setDynamicScale] = useState(1);
  const [isMobile, setIsMobile] = useState(false);
  const [renderWidth, setRenderWidth] = useState(1150);
  const [wrapperSize, setWrapperSize] = useState({ width: 0, height: 0 });
  const [contentSwitch, setContentSwitch] = useState({ contentKey, revealPending: false });
  const restoreFocusRef = useRef(false);
  const lastFocusedInDialogRef = useRef(null);
  if (contentSwitch.contentKey !== contentKey) {
    setContentSwitch({ contentKey, revealPending: open });
  }
  const [awaitingContent, setAwaitingContent] = useState(skipInitialSizeAnimation);
  const [holdCount, setHoldCount] = useState(0);
  const holdCountRef = useRef(0);
  const contentRevealed = !awaitingContent && !contentSwitch.revealPending;

  const MOBILE_PADDING_Y = 80;
  const DESKTOP_PADDING_Y = 36;
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
    const mediaQuery = window.matchMedia("(max-width: 780px)");
    setIsMobile(mediaQuery.matches);

    const handler = (e) => setIsMobile(e.matches);
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  useLayoutEffect(() => {
    if (!open) return; 

    const calculateLayout = () => {
      const width = document.documentElement.clientWidth || window.innerWidth;
      const height = window.innerHeight;
      const currentIsMobile = isMobile || width < 780;

      const paddingY = currentIsMobile ? MOBILE_PADDING_Y : DESKTOP_PADDING_Y;
      const DESKTOP_SCALE_BOOST = 1.03;
      // Reserve the floating banner’s footprint so the modal scales into the space above it.
      const bannerClearance =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--reservation-banner-clearance"
          )
        ) || 0;

      let scale = 1;
      let baseWidth = 0;

      if (currentIsMobile) {
        baseWidth = Math.max(width, 550);
        scale = width / baseWidth;
        scale = Math.min(scale, 1.0);
      } else {
        baseWidth = 1150; 
        const widthScale = (width * 0.95) / baseWidth;

        let heightScale = 1.5;
        if (contentRef.current) {
          const contentH = contentRef.current.offsetHeight;
          const availableH = height - paddingY - bannerClearance;
          heightScale = availableH / contentH;
        }

        scale = Math.min(widthScale, heightScale);
        scale *= DESKTOP_SCALE_BOOST;
      }

      scale = Math.min(Math.max(scale, 0.5), 1.2);

      const nextLayout = {
        scale,
        renderWidth: baseWidth,
        wrapperWidth: contentRef.current ? baseWidth * scale : 0,
        wrapperHeight: contentRef.current
          ? contentRef.current.offsetHeight * scale
          : 0,
      };
      const prevLayout = lastLayoutRef.current;
      const changed =
        Math.abs(prevLayout.scale - nextLayout.scale) > 0.005 ||
        Math.abs(prevLayout.renderWidth - nextLayout.renderWidth) >= 1 ||
        Math.abs(prevLayout.wrapperWidth - nextLayout.wrapperWidth) >= 1 ||
        Math.abs(prevLayout.wrapperHeight - nextLayout.wrapperHeight) >= 1;

      if (!changed) {
        return;
      }

      lastLayoutRef.current = nextLayout;
      setDynamicScale(nextLayout.scale);
      setRenderWidth(nextLayout.renderWidth);
      setWrapperSize({
        width: nextLayout.wrapperWidth,
        height: nextLayout.wrapperHeight,
      });
    };

    const scheduleLayout = () => {
      window.cancelAnimationFrame(layoutFrameRef.current);
      layoutFrameRef.current = window.requestAnimationFrame(calculateLayout);
    };

    calculateLayout();
    window.addEventListener("resize", scheduleLayout);

    const observer = new ResizeObserver(() => scheduleLayout());
    if (contentRef.current) observer.observe(contentRef.current);

    // Recalculate layout when the banner changes its published footprint.
    const clearanceObserver = new MutationObserver(scheduleLayout);
    clearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });

    return () => {
      window.removeEventListener("resize", scheduleLayout);
      window.cancelAnimationFrame(layoutFrameRef.current);
      layoutFrameRef.current = 0;
      observer.disconnect();
      clearanceObserver.disconnect();
    };
  }, [isMobile, children, open, contentKey]);

  useLayoutEffect(() => {
    if (sizeTransitionEnabledRef.current) return;
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
    if (!awaitingContent || holdCount > 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (holdCountRef.current === 0) stopAwaitingContent();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [awaitingContent, holdCount, stopAwaitingContent]);

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
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    if (!open || !isTopDialog(wrapperRef)) return;
    if (wrapperRef.current?.contains(document.activeElement)) return;
    closeButtonRef.current?.focus();
  }, [contentSwitch, open]);

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

  const springTransition = {
    ...(lowPerformanceMode
      ? { duration: 0.16, ease: [0.2, 0, 0, 1] }
      : {
          type: "spring",
          stiffness: 260,
          damping: 30,
          mass: 1,
        }),
  };

  const fadeTransition = {
    duration: lowPerformanceMode ? 0.16 : 0.35,
    ease: [0.4, 0, 0.2, 1],
  };

  const scalerTransition = lowPerformanceMode ? fadeTransition : springTransition;

  const handleGlobalClick = (e) => {
    if (!contentRevealed || !isTopDialog(wrapperRef)) return;
    const dialogRoot = wrapperRef.current || contentRef.current;
    if (dialogRoot && dialogRoot.contains(e.target)) {
      return;
    }
    onClose?.();
  };

  const paddingBlockValue = (isMobile ? MOBILE_PADDING_Y : DESKTOP_PADDING_Y) / 2;

  return (
    <AnimatePresence>
      {open && (
        <motion.div 
          className={`
            fixed inset-0 z-[70] 
            ${isMobile 
              ? "overflow-y-auto overflow-x-hidden" 
              : "overflow-hidden"
            } 
          `}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeTransition}
          onClick={handleGlobalClick}
        >
          {isMobile && (
            <style>{`
              #booking-mobile-override .sm\\:flex-row { flex-direction: column !important; }
              #booking-mobile-override .sm\\:grid-cols-2 { grid-template-columns: repeat(1, minmax(0, 1fr)) !important; }
              #booking-mobile-override .sm\\:grid-cols-3 { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
              #booking-mobile-override .sm\\:col-span-2 { grid-column: span 1 / span 1 !important; }
              #booking-mobile-override .sm\\:w-64 { width: 100% !important; }
            `}</style>
          )}

          <div 
            className="booking-modal-overlay glass-overlay low-perf-overlay fixed inset-0"
            style={{ pointerEvents: "none" }}
          />

          <div 
            className="min-h-full w-full flex flex-col cursor-pointer"
            style={{
              paddingTop: paddingBlockValue,
              paddingBottom: `calc(${paddingBlockValue}px + var(--reservation-banner-clearance, 0px))`,
            }}
          >
            
            {/* Keep the close button inside the aria-modal subtree. This wrapper tracks the visible dialog; the inner scaler only transforms its contents. */}
            <motion.div
              key={contentKey}
              ref={wrapperRef}
              role="dialog"
              aria-modal="true"
              aria-label="Schedule your session"
              className={`ri-booking m-auto relative${contentRevealed ? "" : " invisible"}`}
              initial={{
                width: wrapperSize.width, 
                height: wrapperSize.height 
              }}
              animate={{ 
                width: wrapperSize.width, 
                height: wrapperSize.height 
              }}
              layout={!lowPerformanceMode}
              transition={contentRevealed && sizeTransitionEnabledRef.current ? springTransition : { duration: 0 }}
            >
              {/* Anchor the close button to the unscaled dialog so it stays aligned and retains its 44px touch target. */}
              <button
                id="booking-modal-close"
                aria-label="Close"
                className="absolute right-1 top-1 z-50 flex h-11 w-11 items-center justify-center text-info-text hover:text-white transition text-3xl leading-none opacity-80 hover:opacity-100"
                ref={closeButtonRef}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
              >
                <span aria-hidden="true">×</span>
              </button>

              <motion.div
                data-booking-scaler="true"
                className="shadow-none outline-none overflow-visible absolute top-0 left-0 origin-top-left cursor-default"
                
                initial={
                  lowPerformanceMode
                    ? { scale: dynamicScale, opacity: 0 }
                    : { scale: dynamicScale * 0.95 }
                }
                animate={
                  lowPerformanceMode
                    ? { scale: dynamicScale, opacity: 1 }
                    : { scale: dynamicScale }
                }
                exit={
                  lowPerformanceMode
                    ? { scale: dynamicScale, opacity: 0 }
                    : { scale: dynamicScale * 0.95 }
                }
                transition={contentRevealed ? scalerTransition : { ...scalerTransition, scale: { duration: 0 } }}
              >
                <div
                  ref={contentRef}
                  id={isMobile ? "booking-mobile-override" : undefined}
                  style={{ width: renderWidth, position: 'relative' }}
                >
                  <BookingDialogHoldContext.Provider value={hold}>
                    {React.Children.map(children, child => {
                      if (React.isValidElement(child)) {
                        return React.cloneElement(child, { isMobile });
                      }
                      return child;
                    })}
                  </BookingDialogHoldContext.Provider>
                </div>
              </motion.div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
