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
      statusLabel: "Running",
      bestOf: 5,
      opponent1: { side: "opponent1", name: "Alpha", score: 2 },
      opponent2: { side: "opponent2", name: "Bravo", score: "" },
      nextLabels: ["Winner to Winners Final"],
    });
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
