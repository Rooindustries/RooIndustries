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

const captainTeams = [
  { captain: "wsps", aliases: ["wsps"] },
  { captain: "cookies", aliases: ["cookies"] },
  { captain: "Tap", aliases: ["tap", "tapnocap"] },
  { captain: "Wolfi", aliases: ["wolfi"] },
  { captain: "chosen", aliases: ["chosen"] },
  { captain: "Herluf", aliases: ["herluf", "herloaf"] },
  { captain: "Putter", aliases: ["putter"] },
  {
    captain: "mow the lawn or vanish",
    aliases: ["mowthelawnorvanish", "hampesurf"],
  },
  { captain: "cheesenut", aliases: ["cheesenut"] },
  { captain: "Mint", aliases: ["mint", "mintthief"] },
  { captain: "R3nzTU", aliases: ["r3nztu"] },
  { captain: "skinz", aliases: ["skinz", "skinzow"] },
];

const normalizeCaptainKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const getPlayerKeys = (player = {}) =>
  [player.displayName, player.twitchUsername]
    .map(normalizeCaptainKey)
    .filter(Boolean);

const getCaptainPlayer = (captain, players) =>
  players.find((player) =>
    getPlayerKeys(player).some((key) => captain.aliases.includes(key))
  );

const isCaptainPlayer = (player) =>
  captainTeams.some((captain) =>
    getPlayerKeys(player).some((key) => captain.aliases.includes(key))
  );

const CaptainTeams = ({ players }) => (
  <>
    <div className="tourney-action-callout">
      <strong>12 captain-led teams</strong>
      <span>
        Each roster will have seven players: two Tank, two Damage, two Support,
        and one Flex. Drafted players will be assigned after the July 26 draft.
      </span>
    </div>
    <div className="tourney-captain-grid">
      {captainTeams.map((captain) => {
        const player = getCaptainPlayer(captain, players);
        return (
          <article className="tourney-captain-card" key={captain.captain}>
            <span className="tourney-captain-avatar" aria-hidden="true">
              {captain.captain.charAt(0).toUpperCase()}
            </span>
            <span className="tourney-captain-copy">
              <span className="tourney-kicker">Team captain</span>
              <strong>{captain.captain}</strong>
              <small>{player?.rolePlay || "Captain"}</small>
            </span>
          </article>
        );
      })}
    </div>
  </>
);

export default async function TourneyRosterPage() {
  const [session, hosts, players] = await Promise.all([
    getTourneySession(),
    getTourneyHostsWithLiveStatus().catch(() => undefined),
    readPublicTourneyRoster().then((body) => body.players).catch(() => []),
  ]);
  const draftPoolPlayers = players.filter((player) => !isCaptainPlayer(player));

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
        <Section id="teams" eyebrow="Roster" title="Captain Teams" wide>
          <CaptainTeams players={players} />
        </Section>
      </div>

      <div className="tourney-grid">
        <Section id="draft-pool" eyebrow="Roster" title="Draft Pool" wide>
          {draftPoolPlayers.length > 0 ? (
            <TourneyRosterList players={draftPoolPlayers} />
          ) : (
            <StatusPanel label="Locked" title="No unassigned players">
              Drafted players will appear under their teams after roster lock.
            </StatusPanel>
          )}
        </Section>
      </div>
    </TourneyShell>
  );
}
