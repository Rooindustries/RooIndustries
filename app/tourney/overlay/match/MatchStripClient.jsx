"use client";

import { useState } from "react";
import OverlayFit from "../OverlayFit";
import { useOverlayPoll } from "../useOverlayPoll";

const DEMO_FEED = Object.freeze({
  ok: true,
  apiVersion: "1",
  version: "demo",
  updatedAt: "",
  generated: true,
  published: true,
  live: [
    {
      id: "demo-match",
      label: "Winners Semifinal 1",
      group: "winners",
      groupName: "Winners",
      round: 2,
      number: 1,
      status: "running",
      statusCode: 3,
      statusLabel: "Running",
      live: true,
      completed: false,
      bestOf: 5,
      targetScore: 3,
      opponents: [
        { slot: 1, teamId: "demo-a", name: "Team Alpha", score: 2, result: "", forfeit: false, winner: false },
        { slot: 2, teamId: "demo-b", name: "Team Bravo", score: 1, result: "", forfeit: false, winner: false },
      ],
      next: [],
    },
  ],
  upNext: [],
});

const scoreText = (value) => (value === null || value === undefined ? "–" : value);

const pickFeature = (feed) => {
  if (feed?.live?.length > 0) return { mode: "live", match: feed.live[0] };
  if (feed?.upNext?.length > 0) return { mode: "next", match: feed.upNext[0] };
  return { mode: "idle", match: null };
};

export default function MatchStripClient({
  initialFeed,
  pollSeconds,
  scale,
  demo,
  demoBackground,
  matchId = "",
  team = "",
  fitDebug = false,
}) {
  const [feed, setFeed] = useState(demo ? DEMO_FEED : initialFeed);

  // A pinned strip asks the API for only its match/team so simultaneous
  // matches on other tables never leak onto this stream.
  const pinQuery = matchId
    ? `?match=${encodeURIComponent(matchId)}`
    : team
      ? `?team=${encodeURIComponent(team)}`
      : "";

  useOverlayPoll({
    url: `/api/tourney/v1/matches/live${pinQuery}`,
    intervalMs: pollSeconds * 1000,
    version: feed?.version,
    onUpdate: setFeed,
    enabled: !demo,
  });

  const { mode, match } = pickFeature(feed);
  const [opponentA, opponentB] = match?.opponents || [];
  const hasScores =
    (opponentA?.score ?? null) !== null || (opponentB?.score ?? null) !== null;

  return (
    <div
      className={`tourney-page tourney-overlay ov-strip${
        demoBackground ? " ov-demo-bg" : ""
      }`}
      data-idle={mode === "idle" ? "true" : undefined}
      data-version={feed?.version || ""}
    >
      {match ? (
        <OverlayFit scale={scale} inset={10} debug={fitDebug}>
          <div className={`ov-strip-card is-${mode}`} role="status">
            <span className="ov-strip-badge">
              {mode === "live" ? "Live" : "Up Next"}
            </span>
            <div className="ov-strip-teams">
              <span className="ov-strip-team is-a">{opponentA?.name || "TBD"}</span>
              {hasScores ? (
                <span className="ov-strip-score">
                  {scoreText(opponentA?.score)}
                  <i>–</i>
                  {scoreText(opponentB?.score)}
                </span>
              ) : (
                <span className="ov-strip-score is-vs">vs</span>
              )}
              <span className="ov-strip-team is-b">{opponentB?.name || "TBD"}</span>
            </div>
            <span className="ov-strip-meta">
              <b>{match.label}</b>
              Best of {match.bestOf}
            </span>
          </div>
        </OverlayFit>
      ) : null}
    </div>
  );
}
