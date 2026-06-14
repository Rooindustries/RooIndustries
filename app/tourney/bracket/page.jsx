import {
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import TourneyBracketView from "../TourneyBracketView";
import { getTourneyBracketSnapshot } from "../../../src/server/tourney/bracketStore";

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
  const [session, snapshot] = await Promise.all([
    getTourneySession(),
    getTourneyBracketSnapshot(),
  ]);

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
        <TourneyBracketView snapshot={snapshot} />
      </section>
    </TourneyShell>
  );
}
