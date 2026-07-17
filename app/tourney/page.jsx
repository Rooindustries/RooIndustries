import {
  Section,
  TourneyHosts,
  TourneyShell,
  getTourneyHostsWithLiveStatus,
  getTourneySession,
} from "./TourneyShared";
import JsonLd from "../../src/next/JsonLd";
import seo from "../../src/lib/seo";
import { canAccessTourneyRegistration } from "../../src/server/tourney/access";
import ConnectedAccounts from "../../src/components/ConnectedAccounts";
import TourneyLoginOutcome from "./TourneyLoginOutcome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = seo.getMetadataForPath("/tourney");

const competitiveRules = [
  {
    title: "Format",
    body: "6v6 Overwatch. Double elimination. Bracket matches are Best of 5 and Grand Final is Best of 7 with no bracket reset.",
  },
  {
    title: "Teams",
    body: "Captains draft their own teams from the approved player pool using a tier-based draft format. Rosters lock at 6 starters and 2 substitutes.",
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
    dateLabel: "July 22, 2026",
    body: "Registration closes at 00:00 UTC.",
  },
  {
    title: "Draft day",
    dateLabel: "July 25, 2026",
    body: "Captains will draft their own teams from the approved player pool using a tier-based format. Exact draft time is TBD.",
  },
  {
    title: "Event dates",
    dateLabel: "August 15-16, 2026",
    body: "The tournament runs across both event days. Exact match times are TBD.",
  },
  {
    title: "Match windows",
    body: "Round times, check-in windows, and stream blocks will be posted once teams are confirmed.",
  },
  {
    title: "Winner payouts",
    dateLabel: "By August 30, 2026",
    body: "Tournament winner payouts will be sent within 14 days after the tournament ends.",
  },
  {
    title: "Charity payouts",
    dateLabel: "By October 31, 2026",
    body: "Charity donations will be finalized and sent. Proof of each donation will be posted publicly in the Roo Industries Discord.",
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
    title: "Payment method",
    body: "All tournament-related payments will be made by PayPal only, including winner payouts, prize-equivalent payouts, and charity donations.",
  },
  {
    title: "Website proceeds",
    body: "100% of Roo Industries website revenue from August 1-16, 2026 goes to charity recipients including GAWS, (RED), and The Trevor Project.",
  },
  {
    title: "Giveaways",
    body: "Community prizes and the client-only 9850X3D draw are listed in the giveaway section below. The 9850X3D draw requires a qualifying Roo Industries purchase.",
  },
];

const giveawayItems = [
  {
    title: "Community Discord giveaway",
    body: "3 Logitech G PRO X2 SUPERSTRIKE wireless gaming mice and 32 GB of RAM. Community entry requirements will be posted before entries open.",
  },
  {
    title: "Client-only 9850X3D draw",
    body: "A qualifying Roo Industries purchase is required for the 9850X3D draw. This draw is separate from the community giveaway.",
  },
  {
    title: "Giveaway window",
    body: "The giveaway window will run for 30 days. Roo Industries may start the community giveaway before the tournament so players can join the Discord early.",
  },
  {
    title: "Prize fulfillment",
    body: "Winners will receive the promised item when U.S. shipping is available, or the USD price equivalent based on the U.S. pricing market. Fulfillment will happen within 14 days after winners are confirmed.",
  },
];

const charityRecipients = [
  {
    title: "(RED)",
    body: "Donation recipient.",
    href: "https://www.red.org/",
  },
  {
    title: "GAWS",
    body: "Geelong Animal Welfare Society supports animals in need across the Geelong region.",
    href: "https://www.gaws.org.au/",
    logo: {
      src: "/tourney/charities/gaws-logo.png",
      webp: "/tourney/charities/gaws-logo.webp",
      alt: "GAWS - Geelong Animal Welfare Society",
    },
  },
  {
    title: "The Trevor Project",
    body: "Donation recipient.",
    href: "https://www.thetrevorproject.org/",
  },
];

const DashboardPage = ({ hosts, loginOutcome = "", session }) => (
  <TourneyShell session={session}>
    <section className="tourney-hero" aria-labelledby="tourney-title">
      <div>
        <span className="tourney-badge">Overwatch Creator Tournament</span>
        <h1 id="tourney-title">
          <span className="tourney-title-line">6v6 Legacy Series</span>
        </h1>
        <p>
          Event information, rules, roster status, creator signups, and bracket
          access for the Overwatch Creator Tournament.
        </p>
        {canAccessTourneyRegistration(session) ? (
          <div className="tourney-hero-actions">
            <a className="tourney-register-button" href="/tourney/register">
              <span>Register</span>
            </a>
          </div>
        ) : null}
      </div>
    </section>

    <TourneyLoginOutcome outcome={loginOutcome} />

    {session ? (
      <ConnectedAccounts
        flow="tourney"
        nextPath="/tourney"
        variant="tourney"
      />
    ) : null}

    <TourneyHosts hosts={hosts} />

    <div className="tourney-grid">
      <Section id="dates" eyebrow="Important Dates" title="Important Dates" wide>
        <div className="tourney-date-callout">
          <strong>Drafts begin July 25, 2026</strong>
          <span>
            Captains start drafting their own teams from the approved player
            pool on the already-posted draft date. The draft will be tier-based
            to keep teams balanced, with exact timing and tier details posted
            before draft day.
          </span>
        </div>
        <ul className="tourney-card-list tourney-date-list">
          {scheduleItems.map((item) => (
            <li key={item.title}>
              <strong>{item.title}</strong>
              {item.dateLabel ? (
                <span className="tourney-date-highlight">{item.dateLabel}</span>
              ) : null}
              <span>{item.body}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        id="info"
        eyebrow="Event Information"
        title="Event Information"
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

      <Section id="charities" eyebrow="Charity Drive" title="Charity Revenue Window" wide>
        <div className="tourney-charity-callout">
          <strong>August 1-16, 2026</strong>
          <span>
            Roo Industries is independently donating 100% of website revenue
            from the two weeks before the tournament and the August 15-16
            tournament days to charity recipients including GAWS, (RED), and
            The Trevor Project.
          </span>
          <small>
            Charity listing does not imply sponsorship, endorsement, or
            administration of the tournament.
          </small>
        </div>
        <div className="tourney-charity-grid">
          {charityRecipients.map((recipient) => (
            <a
              className={
                recipient.logo
                  ? "tourney-charity-card has-logo"
                  : "tourney-charity-card"
              }
              href={recipient.href}
              key={recipient.title}
              rel="noopener noreferrer"
              target="_blank"
            >
              {recipient.logo ? (
                <span className="tourney-charity-logo">
                  <picture>
                    <source srcSet={recipient.logo.webp} type="image/webp" />
                    <img
                      alt={recipient.logo.alt}
                      height="259"
                      loading="lazy"
                      src={recipient.logo.src}
                      width="640"
                    />
                  </picture>
                </span>
              ) : (
                <span className="tourney-charity-name">{recipient.title}</span>
              )}
              <strong>{recipient.title}</strong>
              <span>{recipient.body}</span>
            </a>
          ))}
        </div>
      </Section>

      <Section id="giveaway" eyebrow="Giveaway" title="Giveaway Details" wide>
        <div className="tourney-giveaway-callout">
          <strong>Community prizes and a client-only draw</strong>
          <span>
            The public giveaway details will separate Discord community entries
            from the client-only 9850X3D draw, which requires a qualifying Roo
            Industries purchase.
          </span>
        </div>
        <ul className="tourney-card-list tourney-giveaway-list">
          {giveawayItems.map((item) => (
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
        <ul className="tourney-card-list tourney-bracket-list">
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

export default async function TourneyPage({ searchParams } = {}) {
  const [session, hosts, resolvedSearchParams] = await Promise.all([
    getTourneySession(),
    getTourneyHostsWithLiveStatus(),
    searchParams || Promise.resolve({}),
  ]);

  return (
    <>
      <JsonLd data={seo.buildTourneyEventJsonLd()} />
      <DashboardPage
        hosts={hosts}
        loginOutcome={session ? resolvedSearchParams?.notice || "" : ""}
        session={session}
      />
    </>
  );
}
