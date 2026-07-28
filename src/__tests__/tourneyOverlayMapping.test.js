const { toInternalSnapshot } = require("../../app/tourney/overlay/overlayMapping.js");

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
});
