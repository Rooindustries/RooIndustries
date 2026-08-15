const {
  buildTbdBracketMatches,
  collapseLosersByeRoundMatches,
} = require("../../app/tourney/TourneyBracketView.jsx");
const { toInternalSnapshot, filterSnapshotByGroup } = require("../../app/tourney/overlay/overlayMapping.js");

describe("tourney overlay mapping", () => {
  test("converts the public API shape back to the bracket view snapshot shape", () => {
    const internal = toInternalSnapshot({
      ok: true,
      generated: true,
      matches: [
        {
          id: 7,
          label: "Winners Semifinal 1",
          group: "winners",
          groupName: "Winners",
          round: 2,
          number: 1,
          status: "running",
          statusCode: 3,
          statusLabel: "Running",
          live: true,
          completed: false,
          bestOf: 5,
          targetScore: 3,
          publicMatchNumber: 17,
          schedule: { casterIds: [1], dayLabel: "Day 2", timeLabel: "1:45 PM" },
          casters: [{ id: 1, label: "Yukari", color: "purple" }],
          slotLabels: { opponent1: "Winner of 9" },
          autoAdvance: true,
          opponents: [
            { slot: 1, teamId: "team_1", name: "Alpha", score: 2, result: "", forfeit: false, winner: false },
            { slot: 2, teamId: "team_2", name: "Bravo", score: null, result: "", forfeit: false, winner: false },
          ],
          next: ["Winner to Winners Final"],
        },
      ],
    });

    expect(internal.generated).toBe(true);
    expect(internal.matches).toHaveLength(1);
    expect(internal.matches[0]).toMatchObject({
      id: 7,
      number: 1,
      roundNumber: 2,
      groupNumber: 1,
      groupName: "Winners",
      displayLabel: "Winners Semifinal 1",
      status: 3,
      statusLabel: "LIVE",
      bestOf: 5,
      publicMatchNumber: 17,
      schedule: { casterIds: [1], dayLabel: "Day 2", timeLabel: "1:45 PM" },
      casters: [{ id: 1, label: "Yukari", color: "purple" }],
      slotLabels: { opponent1: "Winner of 9" },
      autoAdvance: true,
      opponent1: { side: "opponent1", name: "Alpha", score: 2 },
      opponent2: { side: "opponent2", name: "Bravo", score: "" },
      nextLabels: ["Winner to Winners Final"],
    });
  });

  test("keeps pills only for live, up-next, and cancelled matches", () => {
    const statusOf = (statusLabel) =>
      toInternalSnapshot({
        ok: true,
        generated: true,
        matches: [
          {
            id: 1,
            label: "Match",
            groupName: "Winners",
            round: 1,
            number: 1,
            statusCode: 0,
            statusLabel,
            bestOf: 5,
            opponents: [],
          },
        ],
      }).matches[0].statusLabel;

    expect(statusOf("Running")).toBe("LIVE");
    expect(statusOf("Ready")).toBe("Up Next");
    expect(statusOf("Game Cancelled")).toBe("Cancelled");
    expect(statusOf("Completed")).toBe("");
    expect(statusOf("Archived")).toBe("");
    expect(statusOf("Locked")).toBe("");
    expect(statusOf("Waiting")).toBe("");
  });

  test("tolerates empty and missing payloads", () => {
    expect(toInternalSnapshot(null)).toEqual({
      ok: false,
      generated: false,
      matches: [],
    });
    expect(toInternalSnapshot({ ok: true }).matches).toEqual([]);
  });

  test("matches the five-stage losers-bracket shape in the TBD skeleton", () => {
    const losersRounds = buildTbdBracketMatches()
      .filter((match) => match.groupName === "Losers")
      .reduce((rounds, match) => {
        rounds[match.roundNumber - 1] = (rounds[match.roundNumber - 1] || 0) + 1;
        return rounds;
      }, []);

    expect(losersRounds).toEqual([4, 2, 2, 1, 1]);
  });

  test("removes the generated losers bye round from public displays", () => {
    const generated = [4, 4, 2, 2, 1, 1].flatMap((count, roundIndex) =>
      Array.from({ length: count }, (_, matchIndex) => ({
        id: `r${roundIndex + 1}-m${matchIndex + 1}`,
        groupName: "Losers",
        roundNumber: roundIndex + 1,
        publicMatchNumber: null,
        autoAdvance: roundIndex === 1,
      }))
    );
    const visible = collapseLosersByeRoundMatches(generated);
    const visibleRounds = visible.reduce((rounds, match) => {
      rounds[match.roundNumber - 1] = (rounds[match.roundNumber - 1] || 0) + 1;
      return rounds;
    }, []);

    expect(visibleRounds).toEqual([4, 2, 2, 1, 1]);
    expect(visible.filter((match) => match.roundNumber === 2).map((match) => match.id)).toEqual([
      "r3-m1",
      "r3-m2",
    ]);
  });

  test("preserves scheduled losers matches when the real bye round is first", () => {
    const generated = [
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `bye-${index + 1}`,
        groupName: "Losers",
        roundNumber: 1,
        publicMatchNumber: null,
        autoAdvance: true,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `match-${index + 11}`,
        groupName: "Losers",
        roundNumber: 2,
        publicMatchNumber: index + 11,
        autoAdvance: false,
      })),
      { id: "match-15", groupName: "Losers", roundNumber: 3, publicMatchNumber: 15 },
    ];

    const visible = collapseLosersByeRoundMatches(generated);

    expect(visible.map((match) => match.id)).toEqual([
      "match-11",
      "match-12",
      "match-13",
      "match-14",
      "match-15",
    ]);
    expect(visible.map((match) => match.roundNumber)).toEqual([1, 1, 1, 1, 2]);
  });

  describe("filterSnapshotByGroup", () => {
    const skeleton = [
      { id: "w1", groupName: "Winners" },
      { id: "l1", groupName: "Losers" },
      { id: "gf", groupName: "Grand Final" },
    ];

    test("filters a generated bracket down to one lane", () => {
      const internal = { ok: true, generated: true, matches: skeleton };
      expect(
        filterSnapshotByGroup(internal, "losers").matches.map((m) => m.id)
      ).toEqual(["l1"]);
      expect(
        filterSnapshotByGroup(internal, "grand-final").matches.map((m) => m.id)
      ).toEqual(["gf"]);
    });

    test("filters the TBD skeleton before the bracket is generated", () => {
      const internal = { ok: true, generated: false, matches: [] };
      const filtered = filterSnapshotByGroup(internal, "winners", skeleton);
      expect(filtered.generated).toBe(false);
      expect(filtered.matches.map((m) => m.id)).toEqual(["w1"]);
    });

    test("returns the snapshot untouched without a known group", () => {
      const internal = { ok: true, generated: true, matches: skeleton };
      expect(filterSnapshotByGroup(internal, "")).toBe(internal);
      expect(filterSnapshotByGroup(internal, "nope")).toBe(internal);
    });
  });
});
