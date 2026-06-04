import {
  RouteTitle,
  Section,
  StatusPanel,
  TourneyShell,
  getTourneySession,
} from "../TourneyShared";
import TourneyRosterList from "../TourneyRosterList";
import { listApprovedTourneyPlayers } from "../../../src/server/tourney/playerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Roster | Roo Industries Tourney",
  description: "Private tournament roster dashboard.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyRosterPage() {
  const session = await getTourneySession();
  const players = await listApprovedTourneyPlayers().catch(() => []);

  return (
    <TourneyShell session={session} activeHref="/tourney/roster">
      <RouteTitle eyebrow="Roster" title="Tournament" accent="Roster">
        Approved players appear here before captains draft teams.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="unassigned" eyebrow="Roster" title="Unassigned Players" wide>
          {players.length > 0 ? (
            <TourneyRosterList players={players} />
          ) : (
            <StatusPanel label="Open" title="No approved players yet">
              Approved registrations will show here under Unassigned.
            </StatusPanel>
          )}
        </Section>
      </div>
    </TourneyShell>
  );
}
