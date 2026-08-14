import { render, screen, within } from "@testing-library/react";
import fs from "fs";
import path from "path";

import TourneyBracketView from "../../app/tourney/TourneyBracketView";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  global.ResizeObserver = ResizeObserverStub;
  global.requestAnimationFrame = (callback) => {
    callback();
    return 0;
  };
  global.cancelAnimationFrame = () => {};
});

const side = ({
  sideKey,
  teamId = "",
  name = "TBD",
  score = "",
  result = "",
}) => ({
  side: sideKey,
  participantId: teamId ? `p-${teamId}` : null,
  teamId,
  name,
  score,
  result,
  forfeit: false,
  status: "",
});

const tbdSide = (sideKey) => side({ sideKey });

const match = ({
  id,
  groupName,
  groupNumber,
  roundNumber,
  number,
  publicMatchNumber = null,
  schedule = null,
  casters = [],
  slotLabels = {},
  autoAdvance = false,
  bestOf = 5,
  opponent1,
  opponent2,
}) => ({
  id,
  number,
  roundNumber,
  groupNumber,
  groupName,
  label: `${groupName} R${roundNumber} M${number}`,
  displayLabel: `${groupName} Round ${roundNumber} Match ${number}`,
  publicMatchNumber,
  schedule,
  casters,
  slotLabels,
  autoAdvance,
  status: 2,
  statusLabel: "Ready",
  bestOf,
  targetScore: bestOf === 7 ? 4 : 3,
  opponent1,
  opponent2,
  nextLabels: [],
});

const dayOne = (stageLabel, timeLabel) => ({
  stageLabel,
  dayLabel: "Day 1",
  dateLabel: "August 15, 2026",
  timeLabel,
});

const scheduledSnapshot = () => ({
  generated: true,
  matches: [
    match({
      id: "w1m1",
      groupName: "Winners",
      groupNumber: 1,
      roundNumber: 1,
      number: 2,
      publicMatchNumber: 1,
      schedule: dayOne("Round 1", "12:00 PM"),
      casters: [{ id: 3, label: "GMR" }],
      opponent1: side({ sideKey: "opponent1", teamId: "t1", name: "SayHiToUrDoom" }),
      opponent2: side({ sideKey: "opponent2", teamId: "t2", name: "LFTrade" }),
    }),
    match({
      id: "w1bye",
      groupName: "Winners",
      groupNumber: 1,
      roundNumber: 1,
      number: 3,
      autoAdvance: true,
      opponent1: side({
        sideKey: "opponent1",
        teamId: "t5",
        name: "Rents Due",
        result: "win",
      }),
      opponent2: tbdSide("opponent2"),
    }),
    match({
      id: "w2m1",
      groupName: "Winners",
      groupNumber: 1,
      roundNumber: 2,
      number: 1,
      publicMatchNumber: 5,
      schedule: dayOne("Round 2", "1:45 PM"),
      casters: [{ id: 3, label: "GMR" }],
      slotLabels: { opponent2: "Winner of 1" },
      opponent1: side({ sideKey: "opponent1", teamId: "t9", name: "TickleMonsters" }),
      opponent2: tbdSide("opponent2"),
    }),
    match({
      id: "l1auto",
      groupName: "Losers",
      groupNumber: 2,
      roundNumber: 1,
      number: 1,
      autoAdvance: true,
      opponent1: tbdSide("opponent1"),
      opponent2: tbdSide("opponent2"),
    }),
    match({
      id: "l2m1",
      groupName: "Losers",
      groupNumber: 2,
      roundNumber: 2,
      number: 1,
      publicMatchNumber: 11,
      schedule: dayOne("Losers Round 1", "3:30 PM"),
      casters: [{ id: 3, label: "GMR" }],
      slotLabels: { opponent1: "Loser of 5", opponent2: "Loser of 1" },
      opponent1: tbdSide("opponent1"),
      opponent2: tbdSide("opponent2"),
    }),
    match({
      id: "gf1",
      groupName: "Grand Final",
      groupNumber: 3,
      roundNumber: 1,
      number: 1,
      publicMatchNumber: 22,
      schedule: {
        stageLabel: "Finals",
        dayLabel: "Day 2",
        dateLabel: "August 16, 2026",
        timeLabel: "5:15 PM",
      },
      casters: [
        { id: 1, label: "Yukari + SpankyCheeze" },
        { id: 2, label: "Supa" },
      ],
      slotLabels: { opponent1: "Winner of 17", opponent2: "Winner of 21" },
      bestOf: 7,
      opponent1: tbdSide("opponent1"),
      opponent2: tbdSide("opponent2"),
    }),
  ],
});

describe("TourneyBracketView official schedule", () => {
  test("shows public match numbers, stage labels, and round day/date/time", () => {
    render(<TourneyBracketView snapshot={scheduledSnapshot()} showSchedule />);

    expect(screen.getByText("Match 1")).toBeInTheDocument();
    expect(screen.getByText("Match 5")).toBeInTheDocument();
    expect(screen.getByText("Match 11")).toBeInTheDocument();
    expect(screen.getByText("Match 22")).toBeInTheDocument();

    expect(screen.getByText("Round 1")).toBeInTheDocument();
    expect(screen.getByText("Losers Round 1")).toBeInTheDocument();
    expect(screen.getByText("Finals")).toBeInTheDocument();
    expect(
      screen.getByText("Day 1 · August 15 · 12:00 PM UTC")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Day 1 · August 15 · 3:30 PM UTC")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Day 2 · August 16 · 5:15 PM UTC")
    ).toBeInTheDocument();
  });

  test("hides engine-only auto-advance matches", () => {
    render(<TourneyBracketView snapshot={scheduledSnapshot()} showSchedule />);

    expect(screen.queryByText("Match 3")).not.toBeInTheDocument();
    expect(screen.queryByText("Rents Due")).not.toBeInTheDocument();
    expect(screen.queryByText("Lower Semifinal")).not.toBeInTheDocument();
  });

  test("shows caster assignments as text on each scheduled match", () => {
    render(<TourneyBracketView snapshot={scheduledSnapshot()} showSchedule />);

    const matchOne = screen.getByText("Match 1").closest("article");
    expect(within(matchOne).getByText("Cast: GMR")).toBeInTheDocument();

    const grandFinal = screen.getByText("Match 22").closest("article");
    expect(
      within(grandFinal).getByText("Cast: Yukari + SpankyCheeze, Supa")
    ).toBeInTheDocument();
  });

  test("shows advancement labels for unresolved slots without overwriting teams", () => {
    render(<TourneyBracketView snapshot={scheduledSnapshot()} showSchedule />);

    const matchFive = screen.getByText("Match 5").closest("article");
    expect(within(matchFive).getByText("TickleMonsters")).toBeInTheDocument();
    expect(within(matchFive).getByText("Winner of 1")).toBeInTheDocument();
    expect(within(matchFive).queryByText("TBD")).not.toBeInTheDocument();

    const matchEleven = screen.getByText("Match 11").closest("article");
    expect(within(matchEleven).getByText("Loser of 1")).toBeInTheDocument();
    expect(within(matchEleven).getByText("Loser of 5")).toBeInTheDocument();
  });

  test("keeps engine labels and hides schedule chrome without showSchedule", () => {
    render(<TourneyBracketView snapshot={scheduledSnapshot()} />);

    // The fallback round naming is relative to each group's final round, and
    // the Grand Final rail keeps its computed label instead of "Finals".
    expect(screen.getByText("Winners Final")).toBeInTheDocument();
    expect(screen.getByText("Championship Match")).toBeInTheDocument();
    expect(screen.queryByText("Finals")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Day 1 · August 15 · 12:00 PM UTC")
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Cast:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Winner of 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Rents Due")).not.toBeInTheDocument();
    expect(screen.getByText("Lower Semifinal")).toBeInTheDocument();
    expect(screen.getAllByText("TBD").length).toBeGreaterThan(0);
  });
});

describe("TourneyBracketView caster color coding", () => {
  const casterColorSnapshot = () => ({
    generated: true,
    matches: [
      [2, [{ id: 1, label: "Yukari + SpankyCheeze", color: "purple" }]],
      [3, [{ id: 2, label: "Supa", color: "green" }]],
      [1, [{ id: 3, label: "GMR", color: "red" }]],
      [4, [{ id: 4, label: "KimchiBapBop", color: "pink" }]],
      [12, [{ id: 5, label: "LightOW", color: "black" }]],
      [13, [{ id: 6, label: "Lemon", color: "yellow" }]],
      [21, [
        { id: 1, label: "Yukari", color: "purple" },
        { id: 2, label: "Supa", color: "green" },
      ]],
      [22, [
        { id: 1, label: "Yukari", color: "purple" },
        { id: 2, label: "Supa", color: "green" },
      ]],
    ].map(([publicMatchNumber, casters], index) =>
      match({
        id: `caster-m${publicMatchNumber}`,
        groupName: "Winners",
        groupNumber: 1,
        roundNumber: index + 1,
        number: 1,
        publicMatchNumber,
        schedule: dayOne(`Round ${index + 1}`, "12:00 PM"),
        casters,
        opponent1: tbdSide("opponent1"),
        opponent2: tbdSide("opponent2"),
      })
    ),
  });

  test("tints each scheduled card with its own caster highlight token", () => {
    render(<TourneyBracketView snapshot={casterColorSnapshot()} showSchedule />);

    const expectations = [
      ["Match 1", "var(--caster-red)"],
      ["Match 2", "var(--caster-purple)"],
      ["Match 3", "var(--caster-green)"],
      ["Match 4", "var(--caster-pink)"],
      ["Match 12", "var(--caster-black)"],
      ["Match 13", "var(--caster-yellow)"],
    ];
    for (const [label, token] of expectations) {
      const card = screen.getByText(label).closest("article");
      expect(card.className).toContain("has-caster-highlight");
      expect(card.className).not.toContain("has-caster-duo");
      expect(card.style.getPropertyValue("--caster-1")).toBe(token);
      expect(card.style.getPropertyValue("--caster-2")).toBe("");
    }
    // LightOW's card also carries the black hook so Blackout can ring the
    // card without recoloring the highlight; no other card gets it.
    const blackCard = screen.getByText("Match 12").closest("article");
    expect(blackCard.className).toContain("has-caster-black");
    expect(
      screen.getByText("Match 1").closest("article").className
    ).not.toContain("has-caster-black");
  });

  test("keeps Yukari and Supa's duo highlight on matches 21 and 22", () => {
    render(<TourneyBracketView snapshot={casterColorSnapshot()} showSchedule />);

    for (const label of ["Match 21", "Match 22"]) {
      const card = screen.getByText(label).closest("article");
      expect(card.className).toContain("has-caster-highlight");
      expect(card.className).toContain("has-caster-duo");
      expect(card.style.getPropertyValue("--caster-1")).toBe(
        "var(--caster-purple)"
      );
      expect(card.style.getPropertyValue("--caster-2")).toBe(
        "var(--caster-green)"
      );
      expect(within(card).getByText("Cast: Yukari, Supa")).toBeInTheDocument();
      expect(within(card).queryByText(/SpankyCheeze/)).not.toBeInTheDocument();
    }
  });

  test("prints Lemon only, with no To Be Determined fallback in the cast line", () => {
    render(<TourneyBracketView snapshot={casterColorSnapshot()} showSchedule />);

    const card = screen.getByText("Match 13").closest("article");
    expect(within(card).getByText("Cast: Lemon")).toBeInTheDocument();
    expect(within(card).queryByText(/To Be Determined/)).not.toBeInTheDocument();
  });

  test("keeps the caster tint separate from win/loss side semantics", () => {
    const completed = {
      ...match({
        id: "caster-complete",
        groupName: "Winners",
        groupNumber: 1,
        roundNumber: 1,
        number: 2,
        publicMatchNumber: 1,
        schedule: dayOne("Round 1", "12:00 PM"),
        casters: [{ id: 3, label: "GMR", color: "red" }],
        opponent1: side({
          sideKey: "opponent1",
          teamId: "t1",
          name: "Alpha",
          score: 3,
          result: "win",
        }),
        opponent2: side({
          sideKey: "opponent2",
          teamId: "t2",
          name: "Bravo",
          score: 1,
          result: "loss",
        }),
      }),
      status: 4,
      statusLabel: "Completed",
    };
    render(
      <TourneyBracketView
        snapshot={{ generated: true, matches: [completed] }}
        showSchedule
      />
    );

    const card = screen.getByText("Match 1").closest("article");
    expect(card.className).toContain("has-caster-highlight");
    expect(card.className).toContain("is-completed");
    expect(card.className).not.toContain("is-win");
    expect(card.className).not.toContain("is-loss");
    const sides = card.querySelectorAll(".tourney-match-side");
    expect(sides[0].className).toContain("is-win");
    expect(sides[1].className).toContain("is-loss");
  });

  test("leaves admin and overlay cards untinted without the schedule view", () => {
    render(<TourneyBracketView snapshot={casterColorSnapshot()} />);

    expect(document.querySelectorAll(".has-caster-highlight")).toHaveLength(0);
    expect(screen.queryByText(/Cast:/)).not.toBeInTheDocument();
  });
});

describe("TourneyBracketView mobile card offsets", () => {
  // Reproduces the phone-width ghost-border defect: scheduled quarterfinal
  // cards are taller than the round-1 cards feeding them (bye badge, caster,
  // and status lines), so pinning each card's center to its single visible
  // source dragged each card further up than the last and neighbours
  // overlapped. Geometry is mocked because jsdom has no layout.
  const geometryByLabel = new Map([
    ["Match 1", { top: 322, height: 172 }],
    ["Match 2", { top: 510, height: 172 }],
    ["Match 3", { top: 698, height: 172 }],
    ["Match 4", { top: 886, height: 172 }],
    ["Match 5", { top: 322, height: 193 }],
    ["Match 6", { top: 530, height: 193 }],
    ["Match 7", { top: 738, height: 193 }],
    ["Match 8", { top: 946, height: 193 }],
  ]);

  const fullTreeRect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1200,
    bottom: 2000,
    width: 1200,
    height: 2000,
    toJSON: () => ({}),
  };

  let rectSpy;
  let heightSpy;
  let widthSpy;

  beforeAll(() => {
    rectSpy = jest
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function rect() {
        if (this.classList?.contains("tourney-match-card")) {
          const label = this.querySelector("header span")?.textContent;
          const geo = geometryByLabel.get(label);
          if (geo) {
            // Emulate translateY(var(--match-y-adjust)) the way a real
            // browser moves the rendered box, or the measurement feedback
            // loop cannot converge.
            const adjust =
              parseFloat(this.style.getPropertyValue("--match-y-adjust")) || 0;
            const top = geo.top + adjust;
            return {
              ...fullTreeRect,
              y: top,
              top,
              bottom: top + geo.height,
              height: geo.height,
              right: 214,
              width: 214,
            };
          }
        }
        return fullTreeRect;
      });
    heightSpy = jest
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function height() {
        if (this.classList?.contains("tourney-match-card")) {
          const label = this.querySelector("header span")?.textContent;
          return geometryByLabel.get(label)?.height || 0;
        }
        return 0;
      });
    widthSpy = jest
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockImplementation(function width() {
        return this.classList?.contains("tourney-bracket-tree") ? 1200 : 0;
      });
    // The connector-offset clamp reads the stack row gap via computed style.
    const styleTag = document.createElement("style");
    styleTag.textContent = ".tourney-bracket-stack { row-gap: 16px; }";
    document.head.appendChild(styleTag);
  });

  afterAll(() => {
    rectSpy.mockRestore();
    heightSpy.mockRestore();
    widthSpy.mockRestore();
  });

  const quarterfinalSnapshot = () => ({
    generated: true,
    matches: [
      ...[1, 2, 3, 4].map((number) =>
        match({
          id: `w1r1m${number}`,
          groupName: "Winners",
          groupNumber: 1,
          roundNumber: 1,
          number,
          publicMatchNumber: number,
          schedule: dayOne("Round 1", "12:00 PM"),
          casters: [{ id: 3, label: "GMR" }],
          opponent1: side({
            sideKey: "opponent1",
            teamId: `r1a${number}`,
            name: `RoundOneA${number}`,
          }),
          opponent2: side({
            sideKey: "opponent2",
            teamId: `r1b${number}`,
            name: `RoundOneB${number}`,
          }),
        })
      ),
      ...[1, 2, 3, 4].map((number) =>
        match({
          id: `w1bye${number}`,
          groupName: "Winners",
          groupNumber: 1,
          roundNumber: 1,
          number: number + 4,
          autoAdvance: true,
          opponent1: side({
            sideKey: "opponent1",
            teamId: `bye${number}`,
            name: `ByeTeam${number}`,
            result: "win",
          }),
          opponent2: tbdSide("opponent2"),
        })
      ),
      ...[1, 2, 3, 4].map((number) =>
        match({
          id: `w1r2m${number}`,
          groupName: "Winners",
          groupNumber: 1,
          roundNumber: 2,
          number,
          publicMatchNumber: number + 4,
          schedule: dayOne("Round 2", "1:45 PM"),
          casters: [{ id: 3, label: "GMR" }],
          slotLabels: { opponent2: `Winner of ${number}` },
          opponent1: side({
            sideKey: "opponent1",
            teamId: `bye${number}`,
            name: `ByeTeam${number}`,
          }),
          opponent2: tbdSide("opponent2"),
        })
      ),
    ],
  });

  test("never overlaps neighbouring cards while keeping source alignment", () => {
    render(<TourneyBracketView snapshot={quarterfinalSnapshot()} showSchedule />);

    const cards = [5, 6, 7, 8].map((number) => {
      const card = screen.getByText(`Match ${number}`).closest("article");
      const offset = parseFloat(
        card.style.getPropertyValue("--match-y-adjust")
      );
      const geo = geometryByLabel.get(`Match ${number}`);
      return { number, offset, geo };
    });

    // The first card still leans toward its source round (the alignment
    // feature stays on); each later card is clamped so its translated top
    // clears the previous card's translated bottom plus the 16px stack gap.
    expect(cards[0].offset).toBeLessThan(-5);
    for (let index = 1; index < cards.length; index += 1) {
      const previous = cards[index - 1];
      const current = cards[index];
      const previousBottom =
        previous.geo.top + previous.offset + previous.geo.height;
      const currentTop = current.geo.top + current.offset;
      expect(currentTop).toBeGreaterThanOrEqual(previousBottom + 16);
    }
  });
});

describe("tourney page schedule copy", () => {
  const readPageSource = () =>
    fs.readFileSync(path.join(__dirname, "../../app/tourney/page.jsx"), "utf8");

  test("publishes the official August 15-16 UTC schedule instead of TBD times", () => {
    const source = readPageSource();

    expect(source).not.toContain("Exact match times are TBD");
    expect(source).not.toContain("once teams are confirmed");
    expect(source).toContain("Saturday, August 15, 2026");
    expect(source).toContain("Sunday, August 16, 2026");
    expect(source).toContain("Winners Round 1 at 12:00 PM");
    expect(source).toContain("Losers Round 2 at 5:15 PM UTC");
    expect(source).toContain("Grand Final at 5:15 PM UTC");
  });
});

describe("blackout bracket palette", () => {
  const sharedSource = fs.readFileSync(
    path.join(__dirname, "../../app/tourney/TourneyShared.jsx"),
    "utf8"
  );

  test("dark theme re-skins every hardcoded blue bracket chrome selector", () => {
    for (const selector of [
      'html[data-theme="dark"] .tourney-caster-legend > strong',
      'html[data-theme="dark"] .tourney-caster-legend li',
      'html[data-theme="dark"] .tourney-caster-legend li b',
      'html[data-theme="dark"] .tourney-caster-legend li span',
      'html[data-theme="dark"] .tourney-caster-legend li.is-caster-tinted',
      'html[data-theme="dark"] .tourney-caster-legend li.is-caster-tinted b',
      'html[data-theme="dark"] .tourney-bracket-round > p.tourney-bracket-round-schedule',
      'html[data-theme="dark"] .tourney-match-card header strong',
      'html[data-theme="dark"] .tourney-match-schedule small',
      'html[data-theme="dark"] .tourney-bracket-band.is-losers',
      'html[data-theme="dark"] .tourney-bracket-band.is-losers h3',
      'html[data-theme="dark"] .tourney-bracket-band.is-losers .tourney-match-card',
      'html[data-theme="dark"] .tourney-bracket-stage-path.is-losers',
      'html[data-theme="dark"] .tourney-bracket-band .tourney-match-card.has-caster-highlight',
      'html[data-theme="dark"] .tourney-bracket-band .tourney-match-card.has-caster-duo',
    ]) {
      expect(sharedSource).toContain(selector);
    }
  });

  test("blackout side results stay gold for wins and move to red for losses", () => {
    const start = sharedSource.indexOf('html[data-theme="dark"] .tourney-page,');
    const end = sharedSource.indexOf("}", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = sharedSource.slice(start, end);
    expect(block).toContain("--tourney-side-win-bar: #fbbf24;");
    expect(block).toContain("--tourney-side-win-score: #fde68a;");
    expect(block).toContain("--tourney-side-loss-border: rgba(239, 68, 68, 0.5);");
    expect(block).toContain("--tourney-side-loss-bg: rgba(127, 29, 29, 0.22);");
    expect(block).toContain("--tourney-side-loss-bar: #ef4444;");
    expect(block).toContain("--tourney-side-loss-score: #fca5a5;");
    expect(block).not.toContain("#57534a");
    expect(block).not.toContain("#a8a294");
  });

  test("blackout bracket overrides carry no blue, cyan, or orange chrome", () => {
    const start = sharedSource.indexOf("Blackout bracket chrome");
    const end = sharedSource.indexOf("@media (max-width: 980px)", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = sharedSource.slice(start, end);
    // Red and purple are no longer banned wholesale: caster red/purple and
    // the red loss accent are intentional now. Blue, cyan, orange, and the
    // Roo Blue slate text washes still must not leak into the dark bracket.
    for (const value of [
      "#7dd3fc",
      "#bae6fd",
      "#e0f2fe",
      "#a5f3fc",
      "56, 189, 248",
      "34, 211, 238",
      "125, 211, 252",
      "14, 165, 233",
      "186, 230, 253",
      "148, 163, 184",
      "203, 213, 225",
      "226, 232, 240",
      "251, 146, 60",
    ]) {
      expect(block).not.toContain(value);
    }
  });

  test("default Roo Blue bracket palette stays untouched", () => {
    expect(sharedSource).toContain("--tourney-accent: #22d3ee;");
    expect(sharedSource).toContain(
      "border: 1px solid rgba(56, 189, 248, 0.24);"
    );
    expect(sharedSource).toContain("color: #7dd3fc;");
    expect(sharedSource).toContain("color: rgba(186, 230, 253, 0.78);");
    expect(sharedSource).toContain("--tourney-side-win-bar: #38bdf8;");
    expect(sharedSource).toContain("--tourney-side-loss-bar: #ef4444;");
    expect(sharedSource).toContain("--bracket-flow: rgba(251, 146, 60, 0.82);");
  });

  test("defines one palette token per caster highlight color", () => {
    for (const token of [
      "--caster-pink: #f472b6;",
      "--caster-purple: #c084fc;",
      "--caster-green: #34d399;",
      "--caster-black: #000000;",
      "--caster-yellow: #facc15;",
      "--caster-red: #f87171;",
    ]) {
      expect(sharedSource).toContain(token);
    }
    // LightOW's token stays pure black in Blackout too: the dark token block
    // never redeclares --caster-black and the warm off-white substitution is
    // gone, so the single base declaration governs every theme. A neutral
    // ring on the card and legend swatch keeps the black treatment
    // identifiable on the Blackout surface instead.
    const start = sharedSource.indexOf('html[data-theme="dark"] .tourney-page,');
    const end = sharedSource.indexOf("}", start);
    expect(sharedSource.slice(start, end)).not.toContain("--caster-black");
    expect(sharedSource).not.toContain("--caster-black: #e9e5da;");
    expect(sharedSource.match(/--caster-black:/g)).toHaveLength(1);
  });

  test("both themes keep LightOW's black identifiable with a neutral ring", () => {
    expect(sharedSource).toContain(
      ".tourney-bracket-band .tourney-match-card.has-caster-black"
    );
    expect(sharedSource).toContain(
      "outline: 2px solid color-mix(in srgb, var(--tourney-text) 52%, transparent);"
    );
    expect(sharedSource).toContain(
      ".tourney-caster-legend li.is-caster-tinted.is-caster-black"
    );
    expect(sharedSource).toContain(
      ".tourney-caster-legend li.is-caster-tinted.is-caster-black b"
    );
  });
});
