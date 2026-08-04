"use client";

import { useLayoutEffect, useRef, useState } from "react";

// Site-page counterpart of the OBS overlay's OverlayFit, using the same
// measurement technique: a transform never affects layout, so the inner
// wrapper's offsetWidth/offsetHeight stay natural sizes in every engine and
// the fit cannot feed back. Kept as a small local copy (not an OverlayFit
// import) so the overlay surface stays untouched. The bracket renderer
// already reads the rendered scale from the tree's rect-vs-layout ratio, so
// scaling this ancestor keeps the connectors on the cards, exactly like the
// overlay. The fit is WIDTH-DRIVEN only: the tree always fills the page
// width (scaling up or down as needed) so horizontal scrolling is never
// needed, while the page simply gets taller and scrolls vertically. Below
// the fit breakpoint the board keeps its natural width and the page scrolls
// horizontally (see the matching media queries in TourneyShared.jsx);
// matchMedia keeps this check in lockstep with the CSS.
const FIT_MEDIA_QUERY = "(min-width: 900px)";

export default function BracketFitBoard({ children }) {
  const stageRef = useRef(null);
  const contentRef = useRef(null);
  const [baseSize, setBaseSize] = useState({ width: 0, height: 0 });
  const [fit, setFit] = useState(1);
  const [enabled, setEnabled] = useState(false);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const content = contentRef.current;
    if (!stage || !content) return undefined;

    let frameId = 0;
    // matchMedia keeps the breakpoint in lockstep with the CSS media query;
    // fall back to innerWidth where matchMedia is unavailable (jsdom).
    const fitMedia =
      typeof window.matchMedia === "function"
        ? window.matchMedia(FIT_MEDIA_QUERY)
        : null;
    const measure = () => {
      const active = fitMedia ? fitMedia.matches : window.innerWidth >= 900;
      setEnabled((previous) => (previous === active ? previous : active));
      if (!active) return;
      const baseWidth = content.offsetWidth;
      const baseHeight = content.offsetHeight;
      if (!baseWidth || !baseHeight) return;
      const availableWidth =
        stage.parentElement?.clientWidth || stage.clientWidth;
      const nextFit = availableWidth / baseWidth;
      const rounded = Math.round(nextFit * 1000) / 1000;
      setBaseSize((previous) =>
        previous.width === baseWidth && previous.height === baseHeight
          ? previous
          : { width: baseWidth, height: baseHeight }
      );
      setFit((previous) =>
        Math.abs(previous - rounded) < 0.001 ? previous : rounded
      );
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };

    scheduleMeasure();
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleMeasure)
        : null;
    resizeObserver?.observe(content);
    window.addEventListener("resize", scheduleMeasure);
    document.fonts?.ready?.then(scheduleMeasure).catch(() => {});

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, []);

  const fitted = enabled && baseSize.width > 0;

  return (
    <div
      ref={stageRef}
      className="tourney-bracket-fit"
      style={
        fitted
          ? {
              width: Math.round(baseSize.width * fit),
              height: Math.round(baseSize.height * fit),
            }
          : undefined
      }
    >
      <div
        ref={contentRef}
        className="tourney-bracket-fit-content"
        style={fitted ? { transform: `scale(${fit})` } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
