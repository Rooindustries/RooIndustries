import { TourneyShell, getTourneySession } from "../TourneyShared";
import LiveBracketBoard from "./LiveBracketBoard";
import {
  readPublicTourneyRoster,
  readTourneyService,
} from "../../../src/server/tourney/readService";

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
  const [session, bracketRead, rosterRead] = await Promise.all([
    getTourneySession(),
    readTourneyService({ route: "public_bracket" }),
    readPublicTourneyRoster().catch(() => ({ players: [] })),
  ]);
  const snapshot = bracketRead.body || {};
  const rosterPlayers = rosterRead.players || [];

  return (
    <TourneyShell
      session={session}
      activeHref="/tourney/bracket"
      performanceMode={false}
      wide
    >
      <section
        id="bracket"
        className="tourney-bracket-page"
        aria-labelledby="bracket-title"
      >
        <div className="tourney-bracket-page-head">
          <h2 id="bracket-title">Matchups</h2>
          <p>Live matchups and results for the 6v6 Legacy Series.</p>
        </div>
        <LiveBracketBoard
          initialSnapshot={snapshot}
          rosterPlayers={rosterPlayers}
        />
      </section>
    </TourneyShell>
  );
}
