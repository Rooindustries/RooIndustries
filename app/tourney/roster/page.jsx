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
  const substitutePlayers = players.filter(
    (player) => player.registrationPool === "substitute"
  );

  return (
    <TourneyShell session={session} activeHref="/tourney/roster">
      <RouteTitle eyebrow="Roster" title="Roo Industries" accent="Roster">
        The twelve tournament rosters are set. Substitute players remain
        available if a team needs a replacement.
      </RouteTitle>

      <div className="tourney-grid">
        <Section id="hosts" eyebrow="Hosts" title="Roo Industries Hosts" wide>
          <TourneyRosterHosts hosts={hosts} />
        </Section>
      </div>

      <div className="tourney-grid">
        <Section id="teams" eyebrow="Roster" title="Teams 1–12" wide>
          <TourneyTeamCards players={players} />
        </Section>
      </div>

      <div className="tourney-grid">
        <Section
          id="substitute-pool"
          eyebrow="Roster"
          title="Substitute Pool"
          wide
        >
          {substitutePlayers.length > 0 ? (
            <TourneyRosterList players={substitutePlayers} />
          ) : (
            <StatusPanel label="Substitutes" title="No substitute players">
              No approved substitute players are currently available.
            </StatusPanel>
          )}
        </Section>
      </div>
    </TourneyShell>
  );
}
