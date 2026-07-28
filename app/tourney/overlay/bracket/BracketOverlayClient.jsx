"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import TourneyBracketView, {
  buildTbdBracketMatches,
} from "../../TourneyBracketView";
import { filterSnapshotByGroup, toInternalSnapshot } from "../overlayMapping";
import { useOverlayPoll } from "../useOverlayPoll";

// Auto-fit shrinks the bracket into the browser-source viewport; ?scale= is
// the creator's zoom multiplier on top of that fit. Fit is capped so a tiny
// source (e.g. only the Grand Final) does not blow up to an absurd size.
const MAX_AUTO_FIT_ZOOM = 2.5;
// Matches the .ov-bracket padding so fitted content never clips the frame.
const FRAME_INSET_PX = 8;

export default function BracketOverlayClient({
  initialData,
  pollSeconds,
  scale,
  group,
  demoBackground,
}) {
  const [data, setData] = useState(initialData);
  const contentRef = useRef(null);
  const appliedZoomRef = useRef(1);
  const [fitZoom, setFitZoom] = useState(1);

  useOverlayPoll({
    url: "/api/tourney/v1/bracket",
    intervalMs: pollSeconds * 1000,
    version: data?.version,
    onUpdate: setData,
  });

  const snapshot = useMemo(
    () =>
      filterSnapshotByGroup(
        toInternalSnapshot(data),
        group,
        buildTbdBracketMatches()
      ),
    [data, group]
  );

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;

    let frameId = 0;
    const measure = () => {
      const rect = content.getBoundingClientRect();
      const applied = appliedZoomRef.current || 1;
      const baseWidth = rect.width / applied;
      const baseHeight = rect.height / applied;
      if (!baseWidth || !baseHeight) return;
      const fit = Math.min(
        (window.innerWidth - FRAME_INSET_PX * 2) / baseWidth,
        (window.innerHeight - FRAME_INSET_PX * 2) / baseHeight,
        MAX_AUTO_FIT_ZOOM
      );
      const rounded = Math.round(fit * 1000) / 1000;
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
  }, []);

  const appliedZoom = Math.max(0.05, fitZoom * scale);
  appliedZoomRef.current = appliedZoom;

  return (
    <div
      className={`tourney-page tourney-overlay ov-bracket${
        demoBackground ? " ov-demo-bg" : ""
      }`}
      data-version={data?.version || ""}
    >
      <div
        ref={contentRef}
        className="ov-bracket-fit"
        style={{ zoom: appliedZoom }}
      >
        {/* Remount on zoom change so connector geometry re-measures against
            the zoomed layout instead of keeping stale pixel offsets. */}
        <TourneyBracketView
          key={appliedZoom.toFixed(3)}
          snapshot={snapshot}
        />
      </div>
    </div>
  );
}
