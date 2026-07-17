import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useLocation } from "react-router-dom";
import {
  persistBookingPackageSelection,
  readStoredCheckoutBooking,
} from "../lib/checkoutStorage";
import packagePricing from "../lib/packagePricing";

const { getPublicPackageTitle } = packagePricing;

const HOLD_STORAGE_KEY = "my_slot_hold";
const BOOKING_DRAFT_KEY = "booking_draft";
const MOBILE_MAX_WIDTH = 780;

const useIsMobileWidth = (maxWidth = MOBILE_MAX_WIDTH) => {
  const [isMobileWidth, setIsMobileWidth] = useState(false);

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

const getUtcDateFromHold = (hold) => {
  if (!hold?.startTimeUTC) return null;
  const fromStart = new Date(hold.startTimeUTC);
  return Number.isNaN(fromStart.getTime()) ? null : fromStart;
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
  } catch {
    console.error("Failed to broadcast hold state");
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
      const stored = sessionStorage.getItem(HOLD_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (new Date(parsed.expiresAt) > new Date()) {
          const normalizedHold = {
            holdId: parsed.holdId,
            holdToken: parsed.holdToken,
            expiresAt: parsed.expiresAt,
            startTimeUTC: parsed.startTimeUTC,
            packageTitle: parsed.packageTitle,
            packagePrice: parsed.packagePrice,
            packageTag: parsed.packageTag,
            phase: parsed.phase || "",
          };
          const utcDate = getUtcDateFromHold(normalizedHold);
          if (!utcDate) {
            sessionStorage.removeItem(HOLD_STORAGE_KEY);
            return;
          }
          normalizedHold.startTimeUTC = utcDate.toISOString();
          sessionStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(normalizedHold));
          setHold(normalizedHold);
          broadcastHold(normalizedHold);
        } else {
          sessionStorage.removeItem(HOLD_STORAGE_KEY);
        }
      }
    } catch {
      console.error("Failed to restore reservation banner");
    }
  }, []);

  useEffect(() => {
    const handler = (evt) => {
      const detail = evt.detail || null;
      if (detail) {
        const normalizedHold = {
          holdId: detail.holdId,
          holdToken: detail.holdToken,
          expiresAt: detail.expiresAt,
          startTimeUTC: detail.startTimeUTC,
          packageTitle: detail.packageTitle,
          packagePrice: detail.packagePrice,
          packageTag: detail.packageTag,
          phase: detail.phase || "",
        };
        const utcDate = getUtcDateFromHold(normalizedHold);
        if (!utcDate) {
          sessionStorage.removeItem(HOLD_STORAGE_KEY);
          setHold(null);
          return;
        }
        normalizedHold.startTimeUTC = utcDate.toISOString();
        sessionStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(normalizedHold));
        setHold(normalizedHold);
        return;
      }
      sessionStorage.removeItem(HOLD_STORAGE_KEY);
      setHold(null);
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
        const shouldRedirectHome =
          path.startsWith("/payment") || path.startsWith("/booking");
        releaseHold(true, shouldRedirectHome);
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
  }, [hold, path]);

  const holdLocalTimeLabel = useMemo(() => {
    if (!hold) return "";
    const utcDate = getUtcDateFromHold(hold);
    if (!utcDate) return "";
    return formatLocalTime(utcDate);
  }, [hold]);

  const releaseHold = async (clearOnly = false, redirect = false) => {
    if (!hold) return;
    const holdIdToDelete = hold.holdId;
    const holdTokenToDelete = hold.holdToken;
    setHold(null);
    sessionStorage.removeItem(HOLD_STORAGE_KEY);
    sessionStorage.removeItem(BOOKING_DRAFT_KEY);
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
        body: JSON.stringify({
          holdId: holdIdToDelete,
          holdToken: holdTokenToDelete,
        }),
      }).catch(() =>
        console.error("Failed to release hold on server")
      );
    } catch {
      console.error("Failed to release hold on server");
    }
  };

  const shouldRender = hold && countdown !== null && countdown > 0 && !path.startsWith("/booking");

  const bannerRef = useRef(null);

  // Publish the banner's real footprint so screens underneath can reserve
  // exactly that much space, whatever the banner's current height is.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const root = document.documentElement;
    if (!shouldRender) {
      root.style.removeProperty("--reservation-banner-clearance");
      document.body.style.removeProperty("padding-bottom");
      return undefined;
    }
    const node = bannerRef.current;
    if (!node) return undefined;
    const update = () => {
      const rect = node.getBoundingClientRect();
      const clearance = Math.max(0, Math.ceil(window.innerHeight - rect.top));
      root.style.setProperty(
        "--reservation-banner-clearance",
        `${clearance}px`
      );
      // Also extend the document itself: overlaid screens scroll against the
      // page behind them, so the scroll range must grow by the banner's
      // footprint or the tail of the content can never clear it.
      document.body.style.paddingBottom = `${clearance}px`;
    };
    update();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(node);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      root.style.removeProperty("--reservation-banner-clearance");
      document.body.style.removeProperty("padding-bottom");
    };
  }, [shouldRender]);

  const continueBooking = () => {
    if (String(hold?.phase || "").trim().toLowerCase() === "payment_pending") {
      const bookingData = readStoredCheckoutBooking();
      nav("/payment", {
        state: {
          ...(bookingData ? { bookingData } : {}),
          backgroundLocation: location.state?.backgroundLocation || location,
        },
      });
      return;
    }
    const bookingState = {
      backgroundLocation: location.state?.backgroundLocation || location,
    };
    try {
      const draftRaw = sessionStorage.getItem(BOOKING_DRAFT_KEY);
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
        const selectedPackage = persistBookingPackageSelection(pkg);
        if (selectedPackage) bookingState.bookingPackage = selectedPackage;
      }
    } catch {
      console.error("Failed to restore reservation package");
    }
    nav("/booking", { state: bookingState });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const alignmentClass = isPaymentScreen
    ? "justify-center"
    : isMobileWidth
    ? "justify-start"
    : "justify-center";

  const containerSpacingClass = (() => {
    if (isPaymentScreen) {
      return isMobileWidth
        ? "bottom-1.5 sm:bottom-5 px-2.5 sm:px-4"
        : "bottom-4 lg:bottom-6 px-6";
    }
    return isMobileWidth
      ? "bottom-3 sm:bottom-11 px-2.5 sm:px-5"
      : "bottom-12 lg:bottom-[57px] px-6";
  })();

  const bannerWidthClass = (() => {
    if (isPaymentScreen) {
      return isMobileWidth ? "w-auto max-w-[95vw]" : "w-auto max-w-[46rem]";
    }
    return isMobileWidth
      ? "w-auto max-w-[90vw] sm:max-w-[30rem]"
      : "w-auto max-w-[46rem]";
  })();

  const paddingClass = isPaymentScreen
    ? isMobileWidth
      ? "py-1.5 px-3 sm:px-4"
      : "py-2 px-5"
    : isMobileWidth
    ? "py-2 px-3 sm:px-4"
    : "py-2 px-5";

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

  if (typeof document === "undefined") {
    return null;
  }

  if (!shouldRender) {
    return null;
  }

  return createPortal(
    <div
      className={`pointer-events-none fixed inset-x-0 z-[9999] flex ${alignmentClass} ${containerSpacingClass}`}
    >
      <div
            ref={bannerRef}
            className={`
              pointer-events-auto relative overflow-hidden
              ${bannerWidthClass}
              rounded-2xl 
              glass-premium glass-scroll-lite
              ${paddingClass} 
              inline-flex ${innerFlexDirectionClass} lg:items-center ${gapClass}
              reservation-banner-surface
            `}
      >
        {/* Text Block */}
        <div
          className={`min-w-0 z-10 ${textAlignmentClass} lg:flex lg:items-baseline lg:gap-2.5`}
        >
          <p className={`font-semibold text-ink truncate drop-shadow-md ${titleSizeClass}`}>
            Slot {holdLocalTimeLabel || "--"}
            {hold?.packageTitle
              ? ` · ${getPublicPackageTitle(hold.packageTitle)}`
              : ""}
          </p>
          <p className={`text-info-text truncate drop-shadow-sm ${subtitleSizeClass}`}>
            Expires in {formatCountdown(countdown)}
          </p>
        </div>

        {/* Buttons Block */}
        <div className={`flex items-center ${buttonWrapClass} z-10 lg:flex-none ${buttonGapClass} ${buttonJustifyClass}`}>

          {/* Release Button */}
          {hold?.phase !== "payment_pending" && (
            <button
              type="button"
              onClick={() => releaseHold(false, true)}
              className={`rounded-lg border border-danger-border bg-danger-soft px-2.5 py-1.5 sm:px-3 sm:py-2 ${buttonTextSizeClass} font-semibold text-danger-text hover:bg-danger-soft transition shadow-sm`}
            >
              Release
            </button>
          )}

          {/* Continue button (Hidden on payment screen) */}
          {!isPaymentScreen && (
              <button
                type="button"
                onClick={continueBooking}
                className={`rounded-lg border border-info-border bg-info-soft px-2.5 py-1.5 sm:px-3 sm:py-2 ${buttonTextSizeClass} font-semibold text-info-text hover:bg-info-soft transition whitespace-nowrap shadow-sm`}
              >
                {String(hold?.phase || "").trim().toLowerCase() === "payment_pending"
                  ? "Return to payment"
                  : "Continue booking"}
              </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
