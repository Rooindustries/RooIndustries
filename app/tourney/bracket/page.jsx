import {
  StatusPanel,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import TourneyBracketView from "../TourneyBracketView";
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
        <TourneyBracketView snapshot={snapshot} />
      </section>
    </TourneyShell>
  );
}
