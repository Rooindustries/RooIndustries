import {
  RouteTitle,
  Section,
  StatusPanel,
  TourneyRosterHosts,
  TourneyShell,
  getTourneyHostsWithLiveStatus,
  getTourneySession,
} from "../TourneyShared";
import TourneyRosterList from "../TourneyRosterList";
import TourneyTeamCards from "../TourneyTeamCards";
import { readPublicTourneyRoster } from "../../../src/server/tourney/readService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Roster | Roo Industries",
  description: "Private Roo Industries roster dashboard.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function TourneyRosterPage() {
  const [session, hosts, players] = await Promise.all([
    getTourneySession(),
    getTourneyHostsWithLiveStatus().catch(() => undefined),
    readPublicTourneyRoster().then((body) => body.players).catch(() => []),
  ]);
  const captainPlayers = players.filter((player) => player.isCaptain);
  const unassignedPlayers = players.filter((player) => !player.isCaptain);

  return (
    <TourneyShell session={session} activeHref="/tourney/roster">
      <RouteTitle eyebrow="Roster" title="Roo Industries" accent="Roster">
        Team captains are set. The remaining approved players will be drafted on
        July 26 at 19:00 UTC.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="hosts" eyebrow="Hosts" title="Roo Industries Hosts" wide>
          <TourneyRosterHosts hosts={hosts} />
        </Section>
      </div>

      <div className="tourney-grid">
        <Section id="teams" eyebrow="Roster" title="Teams 1–12" wide>
          <TourneyTeamCards players={captainPlayers} />
        </Section>
      </div>

      <div className="tourney-grid">
        <Section
          id="unassigned-players"
          eyebrow="Roster"
          title="Unassigned Players"
          wide
        >
          {unassignedPlayers.length > 0 ? (
            <TourneyRosterList players={unassignedPlayers} />
          ) : (
            <StatusPanel label="Drafted" title="No unassigned players">
              Every approved player has been assigned to a team.
            </StatusPanel>
          )}
        </Section>
      </div>
    </TourneyShell>
  );
}
