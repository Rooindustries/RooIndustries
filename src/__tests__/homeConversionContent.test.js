const fs = require("fs");
const path = require("path");
const {
  HOME_COPY,
  applyHomeSectionCopyOverride,
} = require("../lib/homeCopy");

describe("homepage conversion content", () => {
  test("speaks to gamers and replaces the old hall-of-fame hero note", () => {
    expect(HOME_COPY.hero.headingLine1).toBe("Why Pay $400 For RAM?");
    expect(HOME_COPY.hero.headingLine2).toBe("Tune Yours For $99.95.");
    expect(HOME_COPY.hero.description).toContain("You probably don't need a new one");
    expect(HOME_COPY.hero.subtext).toContain("Before-and-after benchmarks");
    expect(HOME_COPY.hero.ctaNote).toBe(
      "Same-day sessions available · Money-back guarantee · Lifetime warranty"
    );
    expect(HOME_COPY.hero.ctaNote).not.toContain("Former #16");
  });

  test("features Vulture's Overwatch result with verified hardware", () => {
    const services = applyHomeSectionCopyOverride("services", {
      cards: [],
      benchPages: [
        {
          games: [
            {
              gameTitle: "VALORANT",
              beforeFps: 344,
              afterFps: 627,
              gpu: "RTX 3060 Ti",
            },
          ],
        },
      ],
    });

    expect(services.benchPages[0].games[0]).toMatchObject({
      gameTitle: "Overwatch 2",
      gameLogoUrl: "/overwatch-2-logo.svg",
      beforeFps: 200,
      afterFps: 450,
      gpu: "RTX 4080",
      cpu: "7900X3D",
      ram: "32GB 6000MT/s CL30",
      metricLabel: "Avg FPS",
    });
    expect(services.benchPages[0].games[0]).not.toHaveProperty("details");
    expect(
      fs.existsSync(path.join(__dirname, "../../public/overwatch-2-logo.svg"))
    ).toBe(true);
    expect(services.benchPages[0].games[1].gameTitle).toBe("VALORANT");
  });

  test("removes the expired tournament banner and embeds proof with benefits", () => {
    const homeSource = fs.readFileSync(
      path.join(__dirname, "../legacyPages/Home.jsx"),
      "utf8"
    );
    const servicesSource = fs.readFileSync(
      path.join(__dirname, "../components/Services.jsx"),
      "utf8"
    );

    expect(homeSource).not.toContain("TournamentAnnouncement");
    expect(homeSource).toContain("initialAboutData={initialData?.about || null}");
    expect(servicesSource).toContain("ri-performance-overview");
    expect(servicesSource).toContain("<About initialData={initialAboutData} compact />");
    const aboutSource = fs.readFileSync(
      path.join(__dirname, "../components/About.jsx"),
      "utf8"
    );
    expect(aboutSource).toContain(
      'const compactRecordNote = "Former #16"'
    );
  });
});
