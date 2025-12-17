import React, { useEffect, useRef, useState, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";

export default function BookingModal({ open, onClose, children }) {
  const contentRef = useRef(null);
  
  const [dynamicScale, setDynamicScale] = useState(1);
  const [isMobile, setIsMobile] = useState(false);
  const [renderWidth, setRenderWidth] = useState(1150);
  const [wrapperSize, setWrapperSize] = useState({ width: 0, height: 0 });

  // 1. STRICT 780px BREAKPOINT
  useLayoutEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 780px)");
    setIsMobile(mediaQuery.matches);

    const handler = (e) => setIsMobile(e.matches);
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  // 2. SCALING LOGIC
  useLayoutEffect(() => {
    if (!open) return; 

    const calculateLayout = () => {
      const width = document.documentElement.clientWidth || window.innerWidth;
      const height = window.innerHeight;
      const currentIsMobile = isMobile || width < 780;

      const PADDING_Y = 96; 

      let scale = 1;
      let baseWidth = 0;

      if (currentIsMobile) {
        // Mobile Mode
        baseWidth = Math.max(width, 550);
        scale = width / baseWidth;
        scale = Math.min(scale, 1.0);
      } else {
        // Desktop Mode
        baseWidth = 1150; 
        const widthScale = (width * 0.95) / baseWidth;

        let heightScale = 1.5; 
        if (contentRef.current) {
          const contentH = contentRef.current.offsetHeight;
          const availableH = height - PADDING_Y; 
          heightScale = availableH / contentH;
        }

        scale = Math.min(widthScale, heightScale);
        scale = Math.min(Math.max(scale, 0.5), 1.2);
      }
      
      setDynamicScale(scale);
      setRenderWidth(baseWidth);

      if (contentRef.current) {
        setWrapperSize({
          width: baseWidth * scale,
          height: contentRef.current.offsetHeight * scale
        });
      }
    };

    calculateLayout();
    window.addEventListener("resize", calculateLayout);
    
    const observer = new ResizeObserver(() => calculateLayout());
    if (contentRef.current) observer.observe(contentRef.current);

    return () => {
      window.removeEventListener("resize", calculateLayout);
      observer.disconnect();
    };
  }, [isMobile, children, open]);

  // 3. SCROLL LOCK
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

  // Focus trapping
  useEffect(() => {
    if (!open || !contentRef.current) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // -- ANIMATION CONFIG --
  const springTransition = {
    type: "spring",
    stiffness: 260,
    damping: 30,
    mass: 1
  };

  const fadeTransition = {
    duration: 0.35,
    ease: [0.4, 0, 0.2, 1] 
  };

  const handleGlobalClick = (e) => {
    if (contentRef.current && contentRef.current.contains(e.target)) {
      return; 
    }
    onClose?.();
  };

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

          {/* BACKDROP */}
          <div 
            className="fixed inset-0 bg-black/40 backdrop-blur-[20px]"
            style={{ pointerEvents: "none" }}
          />

          {/* SCROLL CONTAINER */}
          <div className="min-h-full w-full flex flex-col py-12 cursor-pointer">
            
            {/* ANIMATED SIZE WRAPPER */}
            <motion.div 
              className="m-auto relative"
              initial={{ 
                width: wrapperSize.width, 
                height: wrapperSize.height 
              }}
              animate={{ 
                width: wrapperSize.width, 
                height: wrapperSize.height 
              }}
              layout
              transition={springTransition}
            >
              {/* CONTENT SCALER */}
              <motion.div
                role="dialog"
                aria-modal="true"
                className="shadow-none outline-none overflow-visible absolute top-0 left-0 origin-top-left cursor-default"
                
                initial={{ scale: dynamicScale * 0.95 }}
                animate={{ scale: dynamicScale }}
                exit={{ scale: dynamicScale * 0.95 }}
                transition={springTransition}
              >
                {/* CONTENT CONTAINER */}
                <div 
                  ref={contentRef} 
                  id={isMobile ? "booking-mobile-override" : undefined}
                  style={{ width: renderWidth, position: 'relative' }}
                >
                  {/* CLOSE BUTTON (X) 
                      - ml-4 md:ml-8: Responsive Left Margin (Relative Padding)
                      - text-2xl md:text-4xl: Responsive Text Size (Relative Size)
                  */}
                  <button
                    id="booking-modal-close"
                    aria-label="Close"
                    className="absolute left-0 top-0 z-50 ml-4 md:ml-8 text-sky-200 hover:text-white transition text-2xl md:text-4xl leading-none opacity-80 hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose();
                    }}
                  >
                    ×
                  </button>

                  {/* CHILDREN */}
                  {React.Children.map(children, child => {
                    if (React.isValidElement(child)) {
                      return React.cloneElement(child, { isMobile });
                    }
                    return child;
                  })}
                </div>
              </motion.div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
