import {
  Section,
  TourneyHosts,
  TourneyShell,
  getTourneySession,
} from "./TourneyShared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "6v6 Legacy Series | Roo Industries",
  description: "6v6 Legacy Series event information, rules, roster, and bracket.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

const competitiveRules = [
  {
    title: "Format",
    body: "6v6 Overwatch. Double elimination. Bracket matches are Best of 5 and Grand Final is Best of 7 with no bracket reset.",
  },
  {
    title: "Teams",
    body: "Captains draft teams from the approved player pool. Rosters lock at 6 starters and 2 substitutes.",
  },
  {
    title: "Roles",
    body: "No role swaps. Players must play the role they registered, drafted, or were assigned for that series.",
  },
  {
    title: "Subs",
    body: "Only registered substitutes can play after roster lock. Subs enter between maps, never mid-map.",
  },
  {
    title: "Check-In",
    body: "Teams must field 6 eligible players within 10 minutes of match time or admins may call a forfeit.",
  },
  {
    title: "Maps",
    body: "Map 1 is Control. After that, the previous map loser picks the next legal map, mode, and starting side.",
  },
  {
    title: "Hero Bans",
    body: "Each team bans 1 hero per map. Teams cannot repeat their own ban in a series, and both bans cannot be from the same role.",
  },
  {
    title: "Conduct",
    body: "No cheating, throwing, griefing, harassment, stream sniping, lobby leaks, alt play, impersonation, or intentional stalling.",
  },
  {
    title: "Penalties",
    body: "Rule breaks can result in immediate penalty or disqualification. No warnings are required.",
  },
  {
    title: "Community Event Notice",
    body: "Roo Industries runs this tournament independently. It is not endorsed, sponsored, or affiliated with Blizzard Entertainment.",
  },
];

const scheduleItems = [
  {
    title: "Registration closes",
    body: "Registration closes July 22, 2026 at 00:00 UTC.",
  },
  {
    title: "Draft day",
    body: "Teams will be picked in drafts on July 25, 2026. Draft time is TBD.",
  },
  {
    title: "Event dates",
    body: "The tournament runs August 15-16, 2026. Exact match times are TBD.",
  },
  {
    title: "Match windows",
    body: "Round times, check-in windows, and stream blocks will be posted once teams are confirmed.",
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
  {
    title: "Grand Final path",
    body: "The winners-side finalist and the losers-side finalist both qualify for Grand Final.",
  },
];

const infoItems = [
  {
    title: "Format",
    body: "6v6 Overwatch, double elimination, Best of 5 bracket matches, and a Best of 7 Grand Final.",
  },
  {
    title: "Prize pool",
    body: "$2,000 USD for 1st and 2nd place. Split is TBD and payouts are handled after final results are confirmed.",
  },
  {
    title: "Website proceeds",
    body: "Sales from July 25 through August 16, 2026 fund separate 3rd-place and match-MVP payouts.",
  },
  {
    title: "Giveaways",
    body: "9850X3D client draw and Superstrike mouse community giveaway. Entry and draw details are TBD.",
  },
];

const DashboardPage = ({ session }) => (
  <TourneyShell session={session}>
    <section className="tourney-hero" aria-labelledby="tourney-title">
      <div>
        <span className="tourney-badge">Community Overwatch Tournament</span>
        <h1 id="tourney-title">
          <span className="tourney-title-line">6v6 Legacy Series</span>
        </h1>
        <p>
          Event information, rules, roster status, signups, and bracket access
          for the 6v6 Legacy Series.
        </p>
      </div>
    </section>

    <TourneyHosts />

    <div className="tourney-grid">
      <Section id="dates" eyebrow="Important Dates" title="Important Dates" wide>
        <ul className="tourney-card-list tourney-date-list">
          {scheduleItems.map((item) => (
            <li key={item.title}>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        id="info"
        eyebrow="Tourney Information"
        title="Tourney Information"
        wide
      >
        <div className="tourney-action-callout">
          <strong>No warnings for rule breaks</strong>
          <span>
            Any rule break can result in immediate penalty or disqualification.
            Hosts and admins will rule based on proof, impact, and cooperation.
          </span>
        </div>
        <ul className="tourney-info-list">
          {infoItems.map((item) => (
            <li key={item.title}>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="rules" eyebrow="Rules" title="Competitive Rules" wide>
        <p className="tourney-rulebook-intro">
          If you join, check in, or play a map, these rules apply. Owner and
          designated caster rulings are final.
        </p>
        <div className="tourney-map-process">
          <strong>Map and hero-ban process in plain English</strong>
          <p>
            This tournament uses an OWCS-style map and hero-ban process. Map 1
            is Control and the higher seed chooses the Control map and starting
            side. After that, the team that lost the previous map picks the next
            legal map, mode, and starting side. Each team bans one hero per map;
            teams cannot repeat their own hero ban in the same series, and both
            bans on a map cannot be from the same role.
          </p>
        </div>
        <ol className="tourney-rulebook">
          {competitiveRules.map((section) => (
            <li className="tourney-rule" key={section.title}>
              <h3>{section.title}</h3>
              <p>{section.body}</p>
            </li>
          ))}
        </ol>
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
