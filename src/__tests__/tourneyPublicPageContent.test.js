const fs = require("fs");
const path = require("path");

const readTourneyPageSource = () =>
  fs.readFileSync(path.join(__dirname, "../../app/tourney/page.jsx"), "utf8");

const readTourneySharedSource = () =>
  fs.readFileSync(
    path.join(__dirname, "../../app/tourney/TourneyShared.jsx"),
    "utf8"
  );

describe("tourney public page content", () => {
  test("keeps internal Frogger reservation out of public copy", () => {
    const source = readTourneyPageSource();

    expect(source).not.toContain("Reserved support slot");
    expect(source).not.toContain("One Support main-pool spot is reserved");
  });

  test("explains map and hero bans on-site without OWCS external links", () => {
    const source = readTourneyPageSource();

    expect(source).toContain("Map and hero-ban process in plain English");
    expect(source).toContain("tournament uses an OWCS-style map");
    expect(source).not.toContain("esports.overwatch.com/news/owcs");
    expect(source).not.toContain("drive.google.com/file/d/1LuvmuJR0VUxZ8oFAoynYwCj9vr_-9vyD");
    expect(source).not.toContain("drive.google.com/file/d/1XU-lcFOSV5svka6Qf8Dlyc3eNxARHgbz");
  });

  test("places registration between hero copy and hosts", () => {
    const source = readTourneyPageSource();
    const copyIndex = source.indexOf("Event information, rules, roster status");
    const registerIndex = source.indexOf('className="tourney-register-button"');
    const hostsIndex = source.indexOf("<TourneyHosts hosts={hosts} />");
    const datesIndex = source.indexOf('id="dates"');
    const infoIndex = source.indexOf('id="info"');

    expect(copyIndex).toBeGreaterThan(-1);
    expect(registerIndex).toBeGreaterThan(copyIndex);
    expect(hostsIndex).toBeGreaterThan(-1);
    expect(hostsIndex).toBeGreaterThan(registerIndex);
    expect(datesIndex).toBeGreaterThan(hostsIndex);
    expect(infoIndex).toBeGreaterThan(datesIndex);
  });

  test("presents the tournament as a creator event without changing giveaway eligibility", () => {
    const source = readTourneyPageSource();

    expect(source).toContain("Overwatch Creator Tournament");
    expect(source).toContain("creator signups");
    expect(source).toContain("Overwatch Creator Tournament");
    expect(source).toContain("Community Discord giveaway");
    expect(source).toContain("Client-only 9850X3D draw");
    expect(source).not.toContain("Creator 9850X3D");
  });

  test("shows the current registration, draft, and event dates", () => {
    const source = readTourneyPageSource();

    expect(source).toContain('dateLabel: "July 22, 2026"');
    expect(source).toContain("Registration closes at 00:00 UTC.");
    expect(source).toContain("Drafts begin July 25, 2026");
    expect(source).toContain(
      "Captains start drafting their own teams from the approved player"
    );
    expect(source).toContain("The draft will be tier-based");
    expect(source).toContain("to keep teams balanced");
    expect(source).toContain(
      "Captains draft their own teams from the approved player pool using a tier-based draft format."
    );
    expect(source).toContain('dateLabel: "August 15-16, 2026"');
    expect(source).toContain('dateLabel: "By August 30, 2026"');
    expect(source).toContain('dateLabel: "By October 31, 2026"');
    expect(source).toContain('className="tourney-date-highlight"');
    expect(source).not.toContain("is-featured-date");
    expect(source).not.toContain("Registration closes July 15, 2026");
    expect(source).not.toContain("Teams will be picked in drafts on July 18, 2026");
    expect(source).not.toContain("The tournament runs August 1-2, 2026");
  });

  test("shows charity window, approved GAWS logo, and updated giveaways", () => {
    const source = readTourneyPageSource();

    expect(source).toContain("$2,000 USD for 1st and 2nd place");
    expect(source).toContain('title: "Payment method"');
    expect(source).toContain(
      "All tournament-related payments will be made by PayPal only"
    );
    expect(source).toContain(
      "100% of Roo Industries website revenue from August 1-16, 2026"
    );
    expect(source).toContain("GAWS, (RED), and The Trevor Project");
    expect(source).toContain("/tourney/charities/gaws-logo.png");
    expect(source).toContain("/tourney/charities/gaws-logo.webp");
    expect(source).toContain(
      "3 Logitech G PRO X2 SUPERSTRIKE wireless gaming mice"
    );
    expect(source).toContain("32 GB of RAM");
    expect(source).toContain("Client-only 9850X3D draw");
    expect(source).toContain(
      "A qualifying Roo Industries purchase is required for the 9850X3D draw."
    );
    expect(source).toContain("The giveaway window will run for 30 days.");
    expect(source).toContain("U.S. pricing market");
    expect(source).toContain("does not imply sponsorship, endorsement");
    expect(source).toContain('body: "Donation recipient."');
    expect(source.indexOf('title: "(RED)"')).toBeLessThan(
      source.indexOf('title: "GAWS"')
    );
    expect(source.indexOf('title: "GAWS"')).toBeLessThan(
      source.indexOf('title: "The Trevor Project"')
    );
    expect(source).not.toContain("brand approval remains pending");
    expect(source).not.toContain("/tourney/charities/red");
    expect(source).not.toContain("/tourney/charities/trevor");
  });

  test("uses compact 2x2 dates and information grids with vertical rule cards", () => {
    const source = readTourneyPageSource();

    expect(source).toContain('className="tourney-card-list tourney-date-list"');
    expect(source).toContain('className="tourney-info-list"');
    expect(source).toContain(
      'className="tourney-card-list tourney-giveaway-list"'
    );
    expect(source).toContain(
      'className="tourney-card-list tourney-bracket-list"'
    );
    expect(source).toContain("<p>{section.body}</p>");
    expect(source).not.toContain("section.items.map");
  });

  test("centers section headings and keeps numbered bubbles frosted", () => {
    const source = readTourneySharedSource();

    expect(source).toContain(".tourney-section h2");
    expect(source).toContain("text-align: center;");
    expect(source).toContain("@media (min-width: 721px)");
    expect(source).toContain(
      ".tourney-info-list > li:last-child:nth-child(odd)"
    );
    expect(source).toContain(
      ".tourney-bracket-list > li:last-child:nth-child(odd)"
    );
    expect(source).toContain("grid-column: 1 / -1;");
    expect(source).toContain("justify-self: center;");
    expect(source).toContain(
      "width: min(100%, calc(50% - var(--tourney-list-half-gap)));"
    );
    expect(source).toContain("backdrop-filter: blur(18px) saturate(145%)");
    expect(source).toContain(
      "color-mix(in srgb, var(--tourney-surface-strong) 54%, transparent)"
    );
    expect(source).toContain("--tourney-live-badge-slot");
    expect(source).toContain(".tourney-roster-name-line.has-live::before");
    expect(source).toContain(
      'html[data-theme="dark"] .tourney-charity-callout'
    );
    expect(source).toContain(
      "linear-gradient(145deg, rgba(13, 13, 13, 0.88), rgba(24, 20, 12, 0.7))"
    );
    expect(source).not.toContain(`.tourney-rule::before {
      border-color: var(--tourney-border-accent);
      color: var(--tourney-accent-contrast);
      background: var(--gradient-button-primary);`);
  });
});
