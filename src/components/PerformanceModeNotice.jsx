import React, { useEffect, useMemo, useState } from "react";

const MODE_KEY = "roo-lite-mode";
const DISMISS_KEY = "roo-gpu-warning-dismissed";
const MANUAL_KEY = "roo-lite-mode-manual";

const SOFTWARE_RENDERER_PATTERNS = [
  /swiftshader/i,
  /software/i,
  /llvmpipe/i,
  /basic render/i,
  /mesa offscreen/i,
];

const detectLikelySoftwareRendering = () => {
  if (typeof document === "undefined") {
    return { likelySoftware: false, renderer: "unknown" };
  }

  const canvas = document.createElement("canvas");
  const gl =
    canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ||
    canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true }) ||
    canvas.getContext("experimental-webgl", {
      failIfMajorPerformanceCaveat: true,
    });

  if (!gl) {
    return {
      likelySoftware: true,
      renderer: "WebGL unavailable",
    };
  }

  let renderer = "";
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (debugInfo) {
    renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "";
  }
  if (!renderer) {
    renderer = gl.getParameter(gl.RENDERER) || "";
  }

  const likelySoftware = SOFTWARE_RENDERER_PATTERNS.some((pattern) =>
    pattern.test(renderer)
  );

  return {
    likelySoftware,
    renderer: renderer || "Unknown renderer",
  };
};

const setLiteModeClass = (enabled) => {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("low-performance-mode", enabled);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("roo-performance-mode-change"));
  }
};

export default function PerformanceModeNotice() {
  const [liteModeEnabled, setLiteModeEnabled] = useState(false);
  const [showNotice, setShowNotice] = useState(false);
  const [detection, setDetection] = useState({
    likelySoftware: false,
    renderer: "",
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const runDetection = () => {
      const result = detectLikelySoftwareRendering();
      setDetection(result);

      const storedMode = localStorage.getItem(MODE_KEY);
      const manualMode = localStorage.getItem(MANUAL_KEY) === "1";
      let shouldEnableLiteMode = false;

      if (result.likelySoftware) {
        if (manualMode) {
          shouldEnableLiteMode = storedMode === "on";
        } else {
          shouldEnableLiteMode = storedMode !== "off";
        }
      } else {
        shouldEnableLiteMode = storedMode === "on";

        // One-time migration: clear stale auto-enabled mode on hardware renderers.
        if (shouldEnableLiteMode && !manualMode) {
          localStorage.removeItem(MODE_KEY);
          shouldEnableLiteMode = false;
        }
      }

      setLiteModeEnabled(shouldEnableLiteMode);
      setLiteModeClass(shouldEnableLiteMode);

      const dismissed = localStorage.getItem(DISMISS_KEY) === "1";
      setShowNotice(result.likelySoftware && !dismissed);
    };

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(runDetection, { timeout: 1000 });
    } else {
      setTimeout(runDetection, 250);
    }
  }, []);

  const noticeMessage = useMemo(() => {
    if (!detection.likelySoftware) return null;
    return liteModeEnabled
      ? "Hardware acceleration appears disabled. Lite Mode has been enabled for smoother scrolling."
      : "Hardware acceleration appears disabled. Lite Mode is available for smoother scrolling.";
  }, [detection, liteModeEnabled]);

  const toggleLiteMode = () => {
    const next = !liteModeEnabled;
    setLiteModeEnabled(next);
    setLiteModeClass(next);
    localStorage.setItem(MODE_KEY, next ? "on" : "off");
    localStorage.setItem(MANUAL_KEY, "1");
  };

  const dismissNotice = () => {
    setShowNotice(false);
    localStorage.setItem(DISMISS_KEY, "1");
  };

  if (!showNotice || !noticeMessage) return null;

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

        <p className="mt-2 sm:hidden text-[11px] text-slate-100/95 leading-snug">
          Hardware acceleration looks off.
        </p>
        <p className="mt-2 hidden sm:block text-xs sm:text-sm text-slate-100/95 leading-relaxed">
          {noticeMessage}
        </p>
        <p className="mt-2 hidden sm:block text-[11px] text-slate-300/75">
          Chrome: Settings {">"} System {">"} Use graphics acceleration when
          available.
        </p>

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
