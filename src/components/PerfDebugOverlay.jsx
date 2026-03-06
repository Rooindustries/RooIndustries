import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  PERF_TOGGLE_KEYS,
  readPerfDebugToggles,
  setPerfDebugEnabled,
  setPerfDebugToggle,
  subscribePerfDebugChanges,
  syncPerfDebugFromEnvironment,
} from "../lib/perfDebug";

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
};

const toFixed = (value, digits = 1) =>
  Number.isFinite(value) ? Number(value).toFixed(digits) : "0";

export default function PerfDebugOverlay() {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [toggles, setToggles] = useState(readPerfDebugToggles);
  const [stats, setStats] = useState({
    fpsAvg: 0,
    fpsP95: 0,
    fpsP99: 0,
    frames: 0,
    longFrames24: 0,
    longFrames50: 0,
    longFrameRatio: 0,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    clsDelta: 0,
  });

  const frameSamplesRef = useRef([]);
  const longTaskSamplesRef = useRef([]);
  const clsDeltaRef = useRef(0);

  useEffect(() => {
    const sync = () => {
      const result = syncPerfDebugFromEnvironment();
      setEnabled(result.enabled);
      setToggles(result.toggles);
    };

    sync();
    setReady(true);
    const unsubscribe = subscribePerfDebugChanges(sync);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;

    let rafId = 0;
    let sampleTimer = 0;
    let lastFrameTs = performance.now();
    let longTaskObserver = null;
    let clsObserver = null;

    const pruneSamples = (now) => {
      const windowStart = now - 10000;
      frameSamplesRef.current = frameSamplesRef.current.filter(
        (item) => item.ts >= windowStart
      );
      longTaskSamplesRef.current = longTaskSamplesRef.current.filter(
        (item) => item.ts >= windowStart
      );
    };

    const sample = (ts) => {
      const delta = ts - lastFrameTs;
      lastFrameTs = ts;
      if (delta > 0 && delta < 250) {
        frameSamplesRef.current.push({ ts, delta });
      }
      pruneSamples(ts);
      rafId = window.requestAnimationFrame(sample);
    };

    const computeStats = () => {
      const deltas = frameSamplesRef.current.map((item) => item.delta);
      const sum = deltas.reduce((acc, v) => acc + v, 0);
      const avgDelta = sum / Math.max(1, deltas.length);
      const p95Delta = percentile(deltas, 0.95);
      const p99Delta = percentile(deltas, 0.99);
      const longFrames24 = deltas.filter((v) => v > 24).length;
      const longFrames50 = deltas.filter((v) => v > 50).length;
      const longTaskCount = longTaskSamplesRef.current.length;
      const longTaskTotalMs = longTaskSamplesRef.current.reduce(
        (acc, item) => acc + item.duration,
        0
      );

      setStats({
        fpsAvg: avgDelta ? 1000 / avgDelta : 0,
        fpsP95: p95Delta ? 1000 / p95Delta : 0,
        fpsP99: p99Delta ? 1000 / p99Delta : 0,
        frames: deltas.length,
        longFrames24,
        longFrames50,
        longFrameRatio: deltas.length ? (longFrames24 / deltas.length) * 100 : 0,
        longTaskCount,
        longTaskTotalMs,
        clsDelta: clsDeltaRef.current,
      });
    };

    rafId = window.requestAnimationFrame(sample);
    sampleTimer = window.setInterval(computeStats, 500);

    if ("PerformanceObserver" in window) {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const now = performance.now();
          entries.forEach((entry) => {
            longTaskSamplesRef.current.push({
              ts: now,
              duration: entry.duration || 0,
            });
          });
          pruneSamples(now);
        });
        longTaskObserver.observe({ type: "longtask", buffered: true });
      } catch {}

      try {
        clsObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => {
            if (!entry.hadRecentInput) {
              clsDeltaRef.current += entry.value || 0;
            }
          });
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });
      } catch {}
    }

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      if (sampleTimer) window.clearInterval(sampleTimer);
      if (longTaskObserver) longTaskObserver.disconnect();
      if (clsObserver) clsObserver.disconnect();
    };
  }, [enabled]);

  const toggleConfig = useMemo(
    () => [
      {
        key: PERF_TOGGLE_KEYS.NO_NAVBAR_BLUR,
        label: "Disable navbar blur",
      },
      {
        key: PERF_TOGGLE_KEYS.NO_BANNER_BLUR,
        label: "Disable reservation blur",
      },
      {
        key: PERF_TOGGLE_KEYS.PAUSE_REVIEWS_AUTOPLAY,
        label: "Pause reviews autoplay",
      },
      {
        key: PERF_TOGGLE_KEYS.PAUSE_HOWITWORKS_VIDEOS,
        label: "Pause how-it-works videos",
      },
      {
        key: PERF_TOGGLE_KEYS.NO_GLOW_ANIMATIONS,
        label: "Disable glow/shimmer animations",
      },
    ],
    []
  );

  if (!ready || !enabled) return null;

  return (
    <aside className="fixed right-3 sm:right-4 bottom-3 sm:bottom-4 z-[95] w-[min(92vw,420px)] rounded-2xl border border-cyan-400/45 bg-[#061226]/95 p-3 sm:p-4 shadow-[0_0_36px_rgba(34,211,238,0.22)] backdrop-blur-md text-slate-100">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-cyan-200/90 font-semibold">
          Perf Debug
        </div>
        <button
          type="button"
          onClick={() => setPerfDebugEnabled(false)}
          className="rounded-md border border-white/20 bg-white/5 px-2 py-1 text-[11px] font-semibold hover:bg-white/10"
        >
          Hide
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:text-xs">
        <div>FPS avg: {toFixed(stats.fpsAvg)}</div>
        <div>FPS p95: {toFixed(stats.fpsP95)}</div>
        <div>FPS p99: {toFixed(stats.fpsP99)}</div>
        <div>Frames (10s): {stats.frames}</div>
        <div>&gt;24ms: {stats.longFrames24}</div>
        <div>&gt;50ms: {stats.longFrames50}</div>
        <div>Long-frame ratio: {toFixed(stats.longFrameRatio, 2)}%</div>
        <div>CLS delta: {toFixed(stats.clsDelta, 4)}</div>
        <div>Long tasks (10s): {stats.longTaskCount}</div>
        <div>Long task ms: {toFixed(stats.longTaskTotalMs, 1)}</div>
      </div>

      <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
        {toggleConfig.map((item) => (
          <label key={item.key} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={Boolean(toggles[item.key])}
              onChange={(event) => {
                setPerfDebugToggle(item.key, event.target.checked);
                setToggles(readPerfDebugToggles());
              }}
            />
            <span>{item.label}</span>
          </label>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/10 pt-3">
        <button
          type="button"
          onClick={() => {
            toggleConfig.forEach((item) => setPerfDebugToggle(item.key, false));
            setToggles(readPerfDebugToggles());
          }}
          className="rounded-md border border-white/20 bg-white/5 px-2.5 py-1.5 text-[11px] font-semibold hover:bg-white/10"
        >
          Reset toggles
        </button>
        <button
          type="button"
          onClick={() => {
            frameSamplesRef.current = [];
            longTaskSamplesRef.current = [];
            clsDeltaRef.current = 0;
            setStats((prev) => ({
              ...prev,
              frames: 0,
              longFrames24: 0,
              longFrames50: 0,
              longFrameRatio: 0,
              longTaskCount: 0,
              longTaskTotalMs: 0,
              clsDelta: 0,
            }));
          }}
          className="rounded-md border border-cyan-300/40 bg-cyan-500/15 px-2.5 py-1.5 text-[11px] font-semibold hover:bg-cyan-500/25"
        >
          Reset metrics
        </button>
      </div>
    </aside>
  );
}
