import {
  StatusPanel,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import TourneyBracketView from "../TourneyBracketView";
import BracketFitBoard from "./BracketFitBoard";
import { readTourneyService } from "../../../src/server/tourney/readService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Bracket | Roo Industries",
  description: "Live 6v6 Legacy Series bracket.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyBracketPage() {
  const [session, bracketRead] = await Promise.all([
    getTourneySession(),
    readTourneyService({ route: "public_bracket" }),
  ]);
  const snapshot = bracketRead.body || {};
  const casterLegend = Array.isArray(snapshot.schedule?.casters)
    ? snapshot.schedule.casters
    : [];

  return (
    <TourneyShell session={session} activeHref="/tourney/bracket" wide>
      <section
        id="bracket"
        className="tourney-bracket-page"
        aria-labelledby="bracket-title"
      >
        <div className="tourney-bracket-page-head">
          <h2 id="bracket-title">Matchups</h2>
          <p>Live matchups and results for the 6v6 Legacy Series.</p>
        </div>
        {bracketRead.status >= 400 ? (
          <StatusPanel label="Temporarily unavailable" title="Live bracket data is reconnecting">
            The bracket placeholder remains visible. No matchup or result has been changed.
          </StatusPanel>
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
          <TourneyBracketView snapshot={snapshot} showSchedule />
        </BracketFitBoard>
      </section>
    </TourneyShell>
  );
}
