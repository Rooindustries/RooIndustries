const loadStore = () => {
  jest.resetModules();
  return require("../server/tourney/bracketStore.js");
};

const env = {
  TOURNEY_BRACKET_STORE_MODE: "memory",
};

const addTeams = async (store, names = ["Alpha", "Bravo", "Charlie", "Delta"]) => {
  for (let index = 0; index < names.length; index += 1) {
    await store.upsertTourneyBracketTeam({
      name: names[index],
      seed: index + 1,
      actorUsername: "serviroo",
      env,
    });
  }
};

const generateFourTeamBracket = async () => {
  const store = loadStore();
  store.resetMemoryTourneyBracketStoreForTests();
  await addTeams(store);
  const snapshot = await store.generateTourneyBracket({
    actorUsername: "serviroo",
    env,
  });
  return { store, snapshot };
};

describe("tourney bracket store", () => {
  afterEach(() => {
    const store = require("../server/tourney/bracketStore.js");
    store.resetMemoryTourneyBracketStoreForTests();
    jest.resetModules();
  });

  test("generates a local double-elimination bracket with byes and no reset final", async () => {
    const store = loadStore();
    store.resetMemoryTourneyBracketStoreForTests();
    await addTeams(store, ["Alpha", "Bravo", "Charlie"]);

    const snapshot = await store.generateTourneyBracket({
      actorUsername: "serviroo",
      env,
    });

    expect(snapshot.generated).toBe(true);
    expect(snapshot.groups.map((group) => group.name)).toEqual([
      "Winners",
      "Losers",
      "Grand Final",
    ]);
    expect(snapshot.matches.filter((match) => match.groupName === "Grand Final")).toHaveLength(1);
    expect(snapshot.matches.find((match) => match.groupName === "Grand Final")).toMatchObject({
      bestOf: 7,
      targetScore: 4,
    });
  });

  test("serves an isolated eight-team preview fixture without database mode", async () => {
    const store = loadStore();
    store.resetMemoryTourneyBracketStoreForTests();

    const snapshot = await store.getTourneyBracketSnapshot({
      includeAudit: true,
      env: {
        TOURNEY_BRACKET_PREVIEW_FIXTURE: "8x6",
        VERCEL_ENV: "preview",
      },
    });

    expect(snapshot.generated).toBe(true);
    expect(snapshot.teams).toHaveLength(8);
    expect(snapshot.teams.every((team) => team.memberCount === 6)).toBe(true);
    expect(snapshot.teams.every((team) => team.name === "TBD")).toBe(true);
    expect(
      snapshot.matches
        .flatMap((match) => [match.opponent1.name, match.opponent2.name])
        .some((name) => /^Roo /.test(name))
    ).toBe(false);
    expect(snapshot.matches.filter((match) => match.groupName === "Grand Final")).toHaveLength(1);
    expect(snapshot.matches.map((match) => match.displayLabel)).toEqual(
      expect.arrayContaining([
        "Winners Quarterfinal 1",
        "Winners Semifinal 1",
        "Winners Final",
        "Lower Round 1 Match 1",
        "Lower Round 2 Match 1",
        "Lower Semifinal",
        "Lower Final",
        "Grand Final",
      ])
    );
    expect(snapshot.audit[0]).toMatchObject({
      action: "bracket.preview-fixture",
      reason: "8 teams, 6 players each",
    });
  });

  test("scores Bo5 matches and auto-populates the next matchup", async () => {
    const { store, snapshot } = await generateFourTeamBracket();
    const first = snapshot.matches.find(
      (match) => match.groupName === "Winners" && match.roundNumber === 1
    );

    const updated = await store.scoreTourneyBracketMatch({
      matchId: first.id,
      opponent1Score: 3,
      opponent2Score: 1,
      actorUsername: "yukari",
      env,
    });

    expect(updated.matches.find((match) => match.id === first.id)).toMatchObject({
      statusLabel: "Completed",
      opponent1: { score: 3, result: "win" },
      opponent2: { score: 1, result: "loss" },
    });
    expect(
      updated.matches.some(
        (match) =>
          match.id !== first.id &&
          ["Waiting", "Ready"].includes(match.statusLabel) &&
          [match.opponent1.name, match.opponent2.name].includes(first.opponent1.name)
      )
    ).toBe(true);
  });

  test("disqualifies a team, advances the opponent, and keeps public data safe", async () => {
    const { store, snapshot } = await generateFourTeamBracket();
    const first = snapshot.matches.find(
      (match) => match.groupName === "Winners" && match.roundNumber === 1
    );

    const updated = await store.disqualifyTourneyBracketTeam({
      teamId: first.opponent2.teamId,
      matchId: first.id,
      reason: "No show",
      actorUsername: "yukari",
      env,
    });

    const match = updated.matches.find((candidate) => candidate.id === first.id);
    expect(match).toMatchObject({
      statusLabel: "Completed",
      opponent1: { result: "win" },
      opponent2: { result: "loss", forfeit: true },
    });
    expect(
      updated.teams.find((team) => team.id === first.opponent2.teamId)
    ).toMatchObject({ status: "disqualified" });
    expect(JSON.stringify(updated)).not.toMatch(/email|battlenet|timezone|discord/i);
  });

  test("safe reopen blocks completed downstream matches and owner force clears them", async () => {
    const { store, snapshot } = await generateFourTeamBracket();
    const roundOne = snapshot.matches.filter(
      (match) => match.groupName === "Winners" && match.roundNumber === 1
    );

    let updated = await store.scoreTourneyBracketMatch({
      matchId: roundOne[0].id,
      opponent1Score: 3,
      opponent2Score: 1,
      actorUsername: "yukari",
      env,
    });
    updated = await store.scoreTourneyBracketMatch({
      matchId: roundOne[1].id,
      opponent1Score: 3,
      opponent2Score: 1,
      actorUsername: "yukari",
      env,
    });
    const winnersFinal = updated.matches.find(
      (match) => match.groupName === "Winners" && match.roundNumber === 2
    );
    updated = await store.scoreTourneyBracketMatch({
      matchId: winnersFinal.id,
      opponent1Score: 3,
      opponent2Score: 2,
      actorUsername: "yukari",
      env,
    });

    await expect(
      store.reopenTourneyBracketMatch({
        matchId: roundOne[0].id,
        actorUsername: "yukari",
        env,
      })
    ).rejects.toThrow("Owner force reopen is required");

    updated = await store.reopenTourneyBracketMatch({
      matchId: roundOne[0].id,
      force: true,
      actorUsername: "serviroo",
      env,
    });

    expect(updated.matches.find((match) => match.id === roundOne[0].id)).toMatchObject({
      statusLabel: "Ready",
      opponent1: { score: "" },
      opponent2: { score: "" },
    });
    expect(updated.matches.find((match) => match.id === winnersFinal.id).statusLabel).not.toBe(
      "Completed"
    );
  });
});
