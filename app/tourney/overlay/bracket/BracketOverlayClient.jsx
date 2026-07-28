"use client";

import { useMemo, useState } from "react";
import TourneyBracketView from "../../TourneyBracketView";
import { toInternalSnapshot } from "../overlayMapping";
import { useOverlayPoll } from "../useOverlayPoll";

const GROUP_FILTERS = Object.freeze({
  winners: "Winners",
  losers: "Losers",
  "grand-final": "Grand Final",
});

export default function BracketOverlayClient({
  initialData,
  pollSeconds,
  scale,
  group,
  demoBackground,
}) {
  const [data, setData] = useState(initialData);

  useOverlayPoll({
    url: "/api/tourney/v1/bracket",
    intervalMs: pollSeconds * 1000,
    version: data?.version,
    onUpdate: setData,
  });

  const snapshot = useMemo(() => {
    const internal = toInternalSnapshot(data);
    const groupName = GROUP_FILTERS[group];
    if (!groupName || !internal.generated) return internal;
    return {
      ...internal,
      matches: internal.matches.filter(
        (match) => match.groupName === groupName
      ),
    };
  }, [data, group]);

  return (
    <div
      className={`tourney-page tourney-overlay ov-bracket${
        demoBackground ? " ov-demo-bg" : ""
      }`}
      data-version={data?.version || ""}
      style={scale === 1 ? undefined : { zoom: scale }}
    >
      <TourneyBracketView snapshot={snapshot} />
    </div>
  );
}
