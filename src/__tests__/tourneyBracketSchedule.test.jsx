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
