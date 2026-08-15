"use client";

import TourneyBracketView from "../TourneyBracketView";
import { useBracketSnapshotPoll } from "../useBracketSnapshotPoll";
import BracketFitBoard from "./BracketFitBoard";

export default function LiveBracketBoard({ initialSnapshot, rosterPlayers = [] }) {
  const [snapshot] = useBracketSnapshotPoll(initialSnapshot);
  const casterLegend = Array.isArray(snapshot.schedule?.casters)
    ? snapshot.schedule.casters
    : [];

  return (
    <>
      {snapshot?.ok !== true ? (
        <div
          className="tourney-status-panel"
          aria-label="Live bracket data is reconnecting"
        >
          <p className="tourney-kicker">Temporarily unavailable</p>
          <h3>Live bracket data is reconnecting</h3>
          <p>
            The bracket placeholder remains visible. No matchup or result has been
            changed.
          </p>
        </div>
      ) : null}
      {casterLegend.length > 0 ? (
        <div className="tourney-caster-legend" aria-label="Caster legend">
          <strong>Casters</strong>
          <ul>
            {casterLegend.map((caster) => (
              <li
                className={
                  caster.color
                    ? `is-caster-tinted${caster.color === "black" ? " is-caster-black" : ""}`
                    : undefined
                }
                key={caster.id}
                style={
                  caster.color
                    ? { "--caster-color": `var(--caster-${caster.color})` }
                    : undefined
                }
              >
                <b>Caster {caster.id}</b>
                <span>{caster.label}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <BracketFitBoard>
        <TourneyBracketView
          snapshot={snapshot}
          rosterPlayers={rosterPlayers}
          showSchedule
          showTeamRosters
          collapseLosersByeRound
        />
      </BracketFitBoard>
    </>
  );
}
