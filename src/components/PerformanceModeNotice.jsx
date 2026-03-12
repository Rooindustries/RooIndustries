import React, { useCallback, useState } from "react";
import {
  usePerformanceProfile,
  PERFORMANCE_PROFILES,
  PERFORMANCE_NOTICE_DISMISS_KEY,
  DEVICE_CLASSES,
} from "../lib/performanceProfile";

const isNoticeDismissed = () => {
  try {
    return localStorage.getItem(PERFORMANCE_NOTICE_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
};

export default function PerformanceModeNotice() {
  const perf = usePerformanceProfile();
  const [dismissed, setDismissed] = useState(isNoticeDismissed);

  const isLite = perf.profile === PERFORMANCE_PROFILES.LITE;
  const isReduced = perf.profile === PERFORMANCE_PROFILES.REDUCED;
  const isDesktopGpu =
    isLite &&
    perf.deviceClass === DEVICE_CLASSES.DESKTOP &&
    perf.reason === "desktop-software-renderer";

  const showNotice = (isLite || isReduced) && !dismissed;

  const dismissNotice = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(PERFORMANCE_NOTICE_DISMISS_KEY, "1");
    } catch {
      /* storage unavailable */
    }
  }, []);

  if (!showNotice) return null;

  const noticeMessage = isDesktopGpu
    ? "Hardware acceleration appears disabled. Lite Mode has been enabled for smoother scrolling."
    : isLite
      ? "Lite Mode has been enabled for smoother scrolling on this device."
      : "Reduced effects have been enabled for smoother scrolling on this device.";

  return (
    <aside
      className="fixed left-3 sm:left-4 bottom-3 sm:bottom-4 z-[90] w-[min(88vw,320px)] sm:w-[min(92vw,390px)] overflow-hidden rounded-2xl border border-sky-700/50 bg-[#061226]/95 backdrop-blur-md p-3 sm:p-4 text-left shadow-[0_0_30px_rgba(56,189,248,0.26)]"
      role="status"
      aria-live="polite"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.12]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        }}
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/80 to-transparent" />
      <div className="pointer-events-none absolute -inset-x-10 -bottom-16 h-24 bg-cyan-400/10 blur-2xl" />

      <div className="relative z-10">
        <span className="inline-flex items-center rounded-full border border-sky-600/60 bg-sky-900/40 px-3 py-1 text-[11px] font-semibold tracking-wide text-sky-100 shadow-[0_0_12px_rgba(14,165,233,0.25)]">
          Performance Notice
        </span>

        {isDesktopGpu && (
          <p className="mt-2 sm:hidden text-[11px] text-slate-100/95 leading-snug">
            Hardware acceleration looks off.
          </p>
        )}
        <p className="mt-2 hidden sm:block text-xs sm:text-sm text-slate-100/95 leading-relaxed">
          {noticeMessage}
        </p>
        {isDesktopGpu && (
          <p className="mt-2 hidden sm:block text-[11px] text-slate-300/75">
            Chrome: Settings {">"} System {">"} Use graphics acceleration when
            available.
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={dismissNotice}
            className="rounded-lg border border-cyan-300/50 bg-gradient-to-r from-sky-500/80 to-blue-600/80 px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-white shadow-[0_0_14px_rgba(56,189,248,0.35)] hover:from-sky-400 hover:to-blue-500 transition"
          >
            Got it
          </button>
        </div>
      </div>
    </aside>
  );
}
