"use client";

import { useLayoutEffect, useRef, useState } from "react";

// Auto-fit shrinks the content into the browser-source viewport; `scale` is
// the creator's zoom multiplier on top of that fit. Fit is capped so a tiny
// source (e.g. only the Grand Final) does not blow up to an absurd size.
const MAX_AUTO_FIT_ZOOM = 2.5;

// The fit used to rely on CSS `zoom` + getBoundingClientRect feedback, but
// OBS browser sources (CEF 127) do not scale a shrink-to-fit box's rect with
// `zoom`, which made the measure loop diverge to a tiny or huge render. The
// transform below never affects layout, so offsetWidth/offsetHeight are
// stable natural sizes in every engine and the fit cannot feed back.
export default function OverlayFit({ scale = 1, inset = 8, debug = false, children }) {
  const contentRef = useRef(null);
  const [baseSize, setBaseSize] = useState({ width: 0, height: 0 });
  const [fitZoom, setFitZoom] = useState(1);
  const debugRef = useRef([]);
  const [, forceDebugRender] = useState(0);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;

    let frameId = 0;
    const measure = () => {
      const baseWidth = content.offsetWidth;
      const baseHeight = content.offsetHeight;
      if (!baseWidth || !baseHeight) return;
      const fit = Math.min(
        (window.innerWidth - inset * 2) / baseWidth,
        (window.innerHeight - inset * 2) / baseHeight,
        MAX_AUTO_FIT_ZOOM
      );
      if (debug) {
        debugRef.current.push(
          `base ${baseWidth}x${baseHeight} inner ${window.innerWidth}x${window.innerHeight} dpr ${window.devicePixelRatio} fit ${fit.toFixed(4)}`
        );
        if (debugRef.current.length > 12) debugRef.current.shift();
        forceDebugRender((n) => n + 1);
      }
      const rounded = Math.round(fit * 1000) / 1000;
      setBaseSize((previous) =>
        previous.width === baseWidth && previous.height === baseHeight
          ? previous
          : { width: baseWidth, height: baseHeight }
      );
      setFitZoom((previous) =>
        Math.abs(previous - rounded) < 0.001 ? previous : rounded
      );
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };

    scheduleMeasure();
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(content);
    window.addEventListener("resize", scheduleMeasure);
    document.fonts?.ready?.then(scheduleMeasure).catch(() => {});

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [inset, debug]);

  const appliedZoom = Math.max(0.05, fitZoom * scale);

  return (
    <div
      className="ov-fit"
      style={
        baseSize.width
          ? {
              width: Math.round(baseSize.width * appliedZoom),
              height: Math.round(baseSize.height * appliedZoom),
            }
          : undefined
      }
    >
      <div
        ref={contentRef}
        className="ov-fit-content"
        style={{ transform: `scale(${appliedZoom})` }}
      >
        {children}
      </div>
      {debug ? (
        <pre
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            zIndex: 99999,
            margin: 0,
            padding: "10px",
            background: "rgba(255, 0, 0, 0.85)",
            color: "#fff",
            fontSize: "28px",
            lineHeight: 1.25,
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            maxWidth: "100vw",
          }}
        >
          {debugRef.current.join("\n") || "no measures yet"}
        </pre>
      ) : null}
    </div>
  );
}
