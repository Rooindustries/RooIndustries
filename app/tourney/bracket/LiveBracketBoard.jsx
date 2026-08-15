"use client";

import TourneyBracketView from "../TourneyBracketView";
import { useBracketSnapshotPoll } from "../useBracketSnapshotPoll";
import BracketFitBoard from "./BracketFitBoard";

export default function LiveBracketBoard({ initialSnapshot }) {
  const [snapshot] = useBracketSnapshotPoll(initialSnapshot);
  const casterLegend = Array.isArray(snapshot.schedule?.casters)
    ? snapshot.schedule.casters
    : [];

  return (
    <>
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
          showSchedule
          collapseLosersByeRound
        />
      </BracketFitBoard>
    </>
  );
}
