import {
  Section,
  TourneyShell,
  getTourneySession,
} from "./TourneyShared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "6v6 Legacy Series | Roo Industries",
  description: "6v6 Legacy Series presented by Roo Industries.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

const competitiveRules = [
  {
    title: "Tournament Format",
    items: [
      "This is a 6v6 Overwatch tournament with double elimination.",
      "Every bracket match is Best of 5.",
      "Grand Final is Best of 7.",
      "There is no bracket reset. The winners-side team receives first map and side priority in Grand Final.",
    ],
  },
  {
    title: "Teams and Subs",
    items: [
      "Each team has two captains: one captain and one co-captain.",
      "Rosters lock at 6 starters and 2 substitutes.",
      "Captains draft from the player pool.",
      "Each team gets 3 random player rolls for substitute availability. Captains do not hand-pick those extra players.",
      "The first 2 eligible random-roll players become subs. The third roll is only backup if an earlier roll is invalid, unavailable, or declined before roster lock.",
    ],
  },
  {
    title: "Roster Lock",
    items: [
      "Teams can swap players only before official start or check-in close, whichever admins announce.",
      "After the tournament starts, team changes are closed.",
      "Only registered subs can play after roster lock.",
      "Subs can enter only between maps. Never mid-map.",
      "No player can play for more than one team after roster lock.",
    ],
  },
  {
    title: "Late Players and Leaves",
    items: [
      "Field 6 eligible players within 10 minutes of scheduled match time.",
      "Miss that window and admins may call map forfeit, match forfeit, or disqualification.",
      "If a player leaves mid-map after game-of-record, the map continues unless admins rule otherwise.",
      "No eligible sub? You play short or forfeit.",
    ],
  },
  {
    title: "Maps, Hero Bans, and Lobbies",
    items: [
      "Admins publish the map pool and mode order before tournament start.",
      "Map 1 uses admin or seed priority.",
      "After Map 1, the previous map loser picks the next legal map in the mode order. The previous map winner picks side.",
      "No map may repeat in the same series unless admins announce a tiebreaker exception.",
      "Each team gets 1 hero ban per map.",
      "The map picker bans first. Hero bans reset every map.",
      "The lobby host must apply bans and settings before the map starts.",
    ],
  },
  {
    title: "No Throwing or Griefing",
    items: [
      "Do not feed on purpose, AFK, refuse objective play, sabotage teammates, leak comms or strats, stream snipe, leak lobby codes, abuse comms, harass players, cheat, abuse bugs, fix matches, play on alts, or stall on purpose.",
      "Bad games happen. They are not griefing unless evidence shows intent or repeated sabotage.",
      "Play on your own account. Do not impersonate another player.",
      "Keep comms about the match and keep it respectful.",
    ],
  },
  {
    title: "Disputes and Proof",
    items: [
      "Captains or co-captains file disputes unless the issue is harassment, abuse, or player safety.",
      "Bring proof: clips or screenshots with scoreboard, lobby, chat, timer, and player names where possible.",
      "Raise disputes right away, ideally within 10 minutes after the map ends.",
      "Teams must keep playing unless owner, caster, or admin pauses the match.",
      "Owner and designated casters make the final call.",
    ],
  },
  {
    title: "Penalties",
    items: [
      "Penalties can be a warning, loss of map or side priority, map forfeit, match forfeit, player removal, team disqualification, prize forfeiture if prizes exist, dashboard access removal, or a future Roo tournament ban.",
      "Cheating, throwing on purpose, severe harassment, abandoning a match, or tampering with proof can skip warnings and go straight to disqualification or ban.",
      "Admins judge based on the proof available, match impact, repeated behavior, and whether the player or team cooperates.",
    ],
  },
  {
    title: "Community Event Notice",
    items: [
      "Roo Industries runs this tournament independently.",
      "This event is not endorsed by, sponsored by, or affiliated with Blizzard Entertainment.",
      "Matches must be decided by player skill inside the game.",
    ],
  },
];

const scheduleItems = [
  {
    title: "Match windows",
    body: "Round times, check-in windows, and stream blocks will be posted once teams are confirmed.",
  },
  {
    title: "Event dates",
    body: "The tournament runs August 1-2, 2026. Exact match times are still TBA.",
  },
];

const bracketItems = [
  {
    title: "Bracket access",
    body: "The live bracket page shows matchups and results after owner setup.",
  },
  {
    title: "Format",
    body: "Double elimination, Best of 5 bracket matches, and a Best of 7 Grand Final.",
  },
];

const DashboardPage = ({ session }) => (
  <TourneyShell session={session}>
    <section className="tourney-hero" aria-labelledby="tourney-title">
      <div>
        <span className="tourney-badge">Official Roo Industries Tournament</span>
        <h1 id="tourney-title">
          <span className="tourney-title-line">6v6 Legacy Series</span>
          <span className="tourney-title-line tourney-title-accent">
            Presented by Roo Industries
          </span>
        </h1>
        <p>
          Event information, rules, roster status, signups, and bracket access
          for the 6v6 Legacy Series.
        </p>
      </div>
    </section>

    <div className="tourney-grid">
      <Section
        id="info"
        eyebrow="Tourney Information"
        title="Tourney Information"
        wide
      >
        <ul className="tourney-info-list">
          <li>
            <strong>Format</strong>
            <span>6v6 Overwatch. Double-elimination bracket.</span>
          </li>
          <li>
            <strong>Dates</strong>
            <span>
              August 1-2, 2026. Match times go up after check-in and teams are
              locked.
            </span>
          </li>
          <li>
            <strong>Prize pool</strong>
            <span>
              At least $1,000 USD. Final split comes after bracket size is
              locked.
            </span>
          </li>
          <li>
            <strong>Payouts</strong>
            <span>
              All cash payouts are sent through PayPal. Tournament result
              payouts go out within 7 days after final results are confirmed.
              Roo Industries does not cover PayPal transaction fees.
            </span>
          </li>
          <li>
            <strong>Client giveaway</strong>
            <span>9800X3D draw for Roo Industries clients only.</span>
          </li>
          <li>
            <strong>Community giveaway</strong>
            <span>
              Logitech X2 Superstrike draw for the community. You don't need to
              be a client for this one.
            </span>
          </li>
          <li>
            <strong>Giveaway window</strong>
            <span>Giveaway entries run from August 3 to September 3, 2026.</span>
          </li>
          <li>
            <strong>Prize delivery</strong>
            <span>
              CPU and mouse prizes ship only inside the US. Winners outside the
              US receive the cash equivalent by PayPal.
            </span>
          </li>
        </ul>
      </Section>

      <Section id="rules" eyebrow="Rules" title="Competitive Rules" wide>
        <p className="tourney-rulebook-intro">
          If you join, check in, or play a map, these rules apply. Owner and
          designated caster rulings are final.
        </p>
        <ol className="tourney-rulebook">
          {competitiveRules.map((section) => (
            <li className="tourney-rule" key={section.title}>
              <h3>{section.title}</h3>
              <ul>
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="schedule" eyebrow="Schedule" title="Schedule" wide>
        <ul className="tourney-card-list">
          {scheduleItems.map((item) => (
            <li key={item.title}>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="bracket" eyebrow="Bracket" title="Bracket" wide>
        <ul className="tourney-card-list">
          {bracketItems.map((item) => (
            <li key={item.title}>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </li>
          ))}
        </ul>
        <p className="tourney-section-link">
          <a href="/tourney/bracket">Open live bracket</a>
        </p>
      </Section>

    </div>
  </TourneyShell>
);

export default async function TourneyPage() {
  const session = await getTourneySession();

  return <DashboardPage session={session} />;
}
