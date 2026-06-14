const fs = require("fs");
const path = require("path");

const readTourneyPageSource = () =>
  fs.readFileSync(path.join(__dirname, "../../app/tourney/page.jsx"), "utf8");

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

  test("orders hosts before dates and dates before information", () => {
    const source = readTourneyPageSource();
    const hostsIndex = source.indexOf("<TourneyHosts />");
    const datesIndex = source.indexOf('id="dates"');
    const infoIndex = source.indexOf('id="info"');

    expect(hostsIndex).toBeGreaterThan(-1);
    expect(datesIndex).toBeGreaterThan(hostsIndex);
    expect(infoIndex).toBeGreaterThan(datesIndex);
  });

  test("shows the current registration, draft, and event dates", () => {
    const source = readTourneyPageSource();

    expect(source).toContain("Registration closes July 22, 2026 at 00:00 UTC.");
    expect(source).toContain("Teams will be picked in drafts on July 25, 2026.");
    expect(source).toContain("The tournament runs August 15-16, 2026.");
    expect(source).not.toContain("Registration closes July 15, 2026");
    expect(source).not.toContain("Teams will be picked in drafts on July 18, 2026");
    expect(source).not.toContain("The tournament runs August 1-2, 2026");
  });

  test("uses compact 2x2 dates and information grids with vertical rule cards", () => {
    const source = readTourneyPageSource();

    expect(source).toContain('className="tourney-card-list tourney-date-list"');
    expect(source).toContain('className="tourney-info-list"');
    expect(source).toContain("<p>{section.body}</p>");
    expect(source).not.toContain("section.items.map");
  });
});
