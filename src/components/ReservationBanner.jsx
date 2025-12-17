import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";

const HOLD_STORAGE_KEY = "my_slot_hold";
const BOOKING_DRAFT_KEY = "booking_draft";
const HOST_TZ_NAME = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330;
const MOBILE_MAX_WIDTH = 780;

const useIsMobileWidth = (maxWidth = MOBILE_MAX_WIDTH) => {
  const getIsMobile = () =>
    typeof window !== "undefined" ? window.innerWidth <= maxWidth : false;
  const [isMobileWidth, setIsMobileWidth] = useState(getIsMobile);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const handleChange = (event) => setIsMobileWidth(event.matches);
    handleChange(mediaQuery);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }

    return undefined;
  }, [maxWidth]);

  return isMobileWidth;
};

const parseHostLabelToHour = (label) => {
  if (!label) return null;
  const match = label.match(/(\d+):\d{2}\s*(AM|PM)/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  const meridiem = match[2].toUpperCase();
  if (meridiem === "PM") hour += 12;
  return hour;
};

const getUtcFromHostLocal = (year, monthIndex, day, hostHour) => {
  const utcMs =
    Date.UTC(year, monthIndex, day, hostHour, 0) -
    IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcMs);
};

const getUtcDateFromHold = (hold) => {
  if (!hold) return null;
  if (hold.startTimeUTC) {
    const fromStart = new Date(hold.startTimeUTC);
    if (!isNaN(fromStart.getTime())) return fromStart;
  }
  const hostDate = hold.hostDate ? new Date(hold.hostDate) : null;
  const hostHour = parseHostLabelToHour(hold.hostTime);
  if (!hostDate || isNaN(hostDate.getTime()) || hostHour === null) return null;
  return getUtcFromHostLocal(
    hostDate.getFullYear(),
    hostDate.getMonth(),
    hostDate.getDate(),
    hostHour
  );
};

const formatLocalTime = (utcDate) => {
  try {
    return utcDate.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return utcDate.toISOString();
  }
};

const formatCountdown = (ms) => {
  if (!ms || ms <= 0) return "0:00";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const broadcastHold = (payload) => {
  try {
    window.dispatchEvent(new CustomEvent("hold-state", { detail: payload }));
  } catch (e) {
    console.error("Failed to broadcast hold state", e);
  }
};

export default function ReservationBanner() {
  const nav = useNavigate();
  const location = useLocation();
  const [hold, setHold] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const path = location.pathname || "";
  const isMobileWidth = useIsMobileWidth();
  const isDesktopWidth = !isMobileWidth;
  const isPaymentScreen = path.startsWith("/payment");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(HOLD_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (new Date(parsed.expiresAt) > new Date()) {
          setHold(parsed);
          broadcastHold(parsed);
        } else {
          localStorage.removeItem(HOLD_STORAGE_KEY);
        }
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    const handler = (evt) => {
      const detail = evt.detail || null;
      if (detail) {
        localStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(detail));
      }
      if (!detail) {
        localStorage.removeItem(HOLD_STORAGE_KEY);
      }
      setHold(detail);
    };
    window.addEventListener("hold-state", handler);
    return () => window.removeEventListener("hold-state", handler);
  }, []);

  useEffect(() => {
    if (!hold?.expiresAt) {
      setCountdown(null);
      return;
    }
    const expiresAtMs = new Date(hold.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) {
      setCountdown(null);
      return;
    }
    const tick = () => {
      const diff = expiresAtMs - Date.now();
      if (diff <= 0) {
        releaseHold(true);
        return false;
      }
      setCountdown(diff);
      return true;
    };
    tick();
    const id = setInterval(() => {
      const ok = tick();
      if (!ok) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [hold]);

  const holdLocalTimeLabel = useMemo(() => {
    if (!hold) return "";
    const utcDate = getUtcDateFromHold(hold);
    if (!utcDate) return hold.hostTime || "";
    return formatLocalTime(utcDate);
  }, [hold]);

  const releaseHold = async (clearOnly = false, redirect = false) => {
    if (!hold) return;
    const holdIdToDelete = hold.holdId;
    setHold(null);
    localStorage.removeItem(HOLD_STORAGE_KEY);
    localStorage.removeItem(BOOKING_DRAFT_KEY);
    broadcastHold(null);
    if (redirect) {
      const pathName = location.pathname || "";
      const goHome = () => nav("/", { replace: false });
      if (pathName.startsWith("/payment") || pathName.startsWith("/booking")) {
        goHome();
      } else {
        goHome();
      }
    }
    if (clearOnly) return;
    try {
      fetch("/api/releaseHold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdId: holdIdToDelete }),
      }).catch((err) =>
        console.error("Failed to release hold on server:", err)
      );
    } catch (err) {
      console.error("Failed to release hold on server:", err);
    }
  };

  const shouldRender = hold && countdown !== null && countdown > 0 && !path.startsWith("/booking");

  const continueBooking = () => {
    let pathName = "/booking";
    const bookingState = {
      backgroundLocation: location.state?.backgroundLocation || location,
    };
    try {
      const draftRaw = localStorage.getItem(BOOKING_DRAFT_KEY);
      let draftPkg = null;
      if (draftRaw) {
        const draft = JSON.parse(draftRaw);
        draftPkg = draft?.selectedPackage || null;
      }

      const holdPkgTitle =
        typeof hold?.packageTitle === "string" ? hold.packageTitle : null;
      const holdPkgPrice =
        typeof hold?.packagePrice === "string" ? hold.packagePrice : "";
      const holdPkgTag =
        typeof hold?.packageTag === "string" ? hold.packageTag : "";

      let pkg = null;
      if (holdPkgTitle) {
        if (draftPkg && draftPkg.title === holdPkgTitle) {
          pkg = draftPkg;
        } else {
          pkg = { title: holdPkgTitle, price: holdPkgPrice, tag: holdPkgTag };
        }
      } else {
        pkg = draftPkg;
      }

      if (pkg?.title) {
        const params = new URLSearchParams();
        params.set("title", pkg.title);
        if (pkg.price) params.set("price", pkg.price);
        if (pkg.tag) params.set("tag", pkg.tag);
        const isXoc =
          typeof pkg.title === "string" &&
          pkg.title.toLowerCase().includes("xoc");
        params.set("xoc", isXoc ? "1" : "0");
        if (pkg.price) params.set("price", pkg.price);
        if (pkg.tag) params.set("tag", pkg.tag);
        pathName = `/booking?${params.toString()}`;
      }
    } catch (e) {
      console.error("Failed to build resume path:", e);
    }
    nav(pathName, { state: bookingState });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const alignmentClass = isPaymentScreen
    ? "justify-center"
    : isMobileWidth
    ? "justify-start"
    : "justify-center";

  const containerSpacingClass = isMobileWidth
    ? "bottom-3 sm:bottom-11 px-2.5 sm:px-5"
    : "bottom-12 lg:bottom-[57px] px-6";

  const bannerWidthClass = (() => {
    if (isPaymentScreen) {
      return isMobileWidth
        ? "w-full max-w-full"
        : "w-full max-w-[36rem] lg:max-w-[50rem]";
    }
    return isMobileWidth
      ? "w-auto max-w-[90vw] sm:max-w-[30rem]"
      : "w-full max-w-[42rem] lg:max-w-[50rem]";
  })();

  const paddingClass = isPaymentScreen
    ? isMobileWidth
      ? "py-1.5 px-3 sm:px-4"
      : "py-3.5 px-5 lg:px-6"
    : isMobileWidth
    ? "py-2 px-3 sm:px-4"
    : "py-3.5 px-5 lg:px-6";

  const innerFlexDirectionClass = isPaymentScreen
    ? isMobileWidth
      ? "flex-row justify-center"
      : "flex-row items-center justify-center"
    : isMobileWidth
    ? "flex-col justify-center"
    : "flex-row justify-center lg:justify-between";

  const textAlignmentClass = isPaymentScreen
    ? isMobileWidth
      ? "text-center flex-none"
      : "text-center flex-none"
    : "text-left flex-1";

  const titleSizeClass = isMobileWidth ? "text-xs sm:text-sm" : "text-base";
  const subtitleSizeClass = isMobileWidth ? "text-[11px] sm:text-[12px]" : "text-sm";
  const buttonTextSizeClass = isMobileWidth ? "text-[11px] sm:text-xs" : "text-sm";
  const gapClass = isDesktopWidth ? "gap-3" : "gap-2 sm:gap-2.5";
  const buttonGapClass = isDesktopWidth ? "gap-2.5" : "gap-1.5 sm:gap-2";
  const buttonJustifyClass =
    isPaymentScreen && isDesktopWidth ? "justify-center" : isDesktopWidth ? "justify-end" : "justify-center";
  const buttonWrapClass = isPaymentScreen && isDesktopWidth ? "flex-nowrap" : "flex-wrap";

  return createPortal(
    <AnimatePresence>
      {shouldRender && (
        <motion.div 
          className={`pointer-events-none fixed inset-x-0 z-[9999] flex ${alignmentClass} ${containerSpacingClass}`}
          
          // Animation definitions
          initial={{ opacity: 0, y: 30 }} 
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 30 }}
          transition={{ type: "spring", stiffness: 150, damping: 25, duration: 0.4 }} 
        >
          <div
            className={`
              pointer-events-auto relative overflow-hidden 
              ${bannerWidthClass}
              rounded-2xl 
              border border-white/10 
              bg-slate-900/70 
              shadow-[0_8px_32px_0_rgba(0,0,0,0.37)] 
              ${paddingClass} 
              inline-flex ${innerFlexDirectionClass} lg:items-center ${gapClass}
            `}
            style={{ 
              backdropFilter: "blur(40px)", 
              WebkitBackdropFilter: "blur(40px)" 
            }}
          >
            {/* Text Block */}
            <div className={`min-w-0 z-10 ${textAlignmentClass}`}>
              <p className={`font-semibold text-white truncate drop-shadow-md ${titleSizeClass}`}>
                Slot {holdLocalTimeLabel || hold.hostTime || "--"}
                {hold?.packageTitle ? ` — ${hold.packageTitle}` : ""}
              </p>
              <p className={`text-sky-200/90 truncate drop-shadow-sm ${subtitleSizeClass}`}>
                Expires in {formatCountdown(countdown)} • Host {hold.hostTime} ({HOST_TZ_NAME})
              </p>
            </div>
            
            {/* Buttons Block */}
            <div className={`flex items-center ${buttonWrapClass} z-10 lg:flex-none ${buttonGapClass} ${buttonJustifyClass}`}>
              
              {/* Release Button */}
              <button
                type="button"
                onClick={() => releaseHold(false, true)}
                className={`rounded-lg border border-red-400/30 bg-red-500/20 px-2.5 py-1.5 sm:px-3 sm:py-2 ${buttonTextSizeClass} font-semibold text-red-50 hover:bg-red-500/30 transition shadow-sm`}
              >
                Release
              </button>
              
              {/* Continue button (Hidden on payment screen) */}
              {!isPaymentScreen && (
                <button
                  type="button"
                  onClick={continueBooking}
                  className={`rounded-lg border border-sky-400/30 bg-sky-500/20 px-2.5 py-1.5 sm:px-3 sm:py-2 ${buttonTextSizeClass} font-semibold text-sky-50 hover:bg-sky-500/30 transition whitespace-nowrap shadow-sm`}
                >
                  Continue booking
                </button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
