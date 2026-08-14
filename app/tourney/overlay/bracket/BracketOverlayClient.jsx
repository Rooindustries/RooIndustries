"use client";

import { useMemo, useState } from "react";
import TourneyBracketView, {
  buildTbdBracketMatches,
} from "../../TourneyBracketView";
import OverlayFit from "../OverlayFit";
import { filterSnapshotByGroup, toInternalSnapshot } from "../overlayMapping";
import { useOverlayPoll } from "../useOverlayPoll";

export default function BracketOverlayClient({
  initialData,
  pollSeconds,
  scale,
  group,
  demoBackground,
  fitDebug = false,
}) {
  const [data, setData] = useState(initialData);

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

  return (
    <div
      className={`tourney-page tourney-overlay ov-bracket${
        demoBackground ? " ov-demo-bg" : ""
      }`}
      data-version={data?.version || ""}
    >
      <OverlayFit scale={scale} inset={8} debug={fitDebug}>
        <TourneyBracketView snapshot={snapshot} showSchedule />
      </OverlayFit>
    </div>
  );
}
