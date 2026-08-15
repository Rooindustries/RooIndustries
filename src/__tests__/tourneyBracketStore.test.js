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
      publicMatchNumber: null,
      schedule: null,
    });
    expect(snapshot.schedule).toBeNull();
  });

  test("serves an isolated twelve-team preview fixture without database mode", async () => {
    const store = loadStore();
    store.resetMemoryTourneyBracketStoreForTests();

    const snapshot = await store.getTourneyBracketSnapshot({
      includeAudit: true,
      env: {
        TOURNEY_BRACKET_PREVIEW_FIXTURE: "12x6",
        VERCEL_ENV: "preview",
      },
    });

    expect(snapshot.generated).toBe(true);
    expect(snapshot.teams).toHaveLength(12);
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
        "Winners Round 1 Match 1",
        "Winners Quarterfinal 1",
        "Winners Semifinal 1",
        "Winners Final",
        "Lower Round 1 Match 1",
        "Lower Round 4 Match 2",
        "Lower Semifinal",
        "Lower Final",
        "Grand Final",
      ])
    );
    expect(snapshot.audit[0]).toMatchObject({
      action: "bracket.preview-fixture",
      reason: "12 teams, 6 players each",
    });
  });

  test("maps the official 22-match schedule onto the twelve-team engine bracket", async () => {
    const store = loadStore();
    store.resetMemoryTourneyBracketStoreForTests();

    const snapshot = await store.getTourneyBracketSnapshot({
      env: { TOURNEY_BRACKET_PREVIEW_FIXTURE: "12x6" },
    });
    const scheduled = snapshot.matches
      .filter((match) => match.publicMatchNumber !== null)
      .sort((left, right) => left.publicMatchNumber - right.publicMatchNumber);

    expect(snapshot.schedule).toMatchObject({
      timeZone: "PST",
      eventDates: ["2026-08-15", "2026-08-16"],
      casters: [
        { id: 1, label: "Yukari + SpankyCheeze", color: "purple" },
        { id: 2, label: "Supa", color: "green" },
        { id: 3, label: "GMR", color: "red" },
        { id: 4, label: "KimchiBapBop", color: "pink" },
        { id: 5, label: "LightOW", color: "black" },
        { id: 6, label: "Lemon", color: "yellow" },
        { id: 7, label: "Ace", color: "blue" },
      ],
    });
    expect(snapshot.schedule.rounds).toHaveLength(10);
    expect(snapshot.schedule.rounds.map(({ key, dayLabel, timeLabel }) => ({
      key,
      dayLabel,
      timeLabel,
    }))).toEqual([
      { key: "winners:1", dayLabel: "Day 1", timeLabel: "12:00 PM" },
      { key: "winners:2", dayLabel: "Day 1", timeLabel: "1:45 PM" },
      { key: "winners:3", dayLabel: "Day 1", timeLabel: "3:30 PM" },
      { key: "losers:2", dayLabel: "Day 1", timeLabel: "3:30 PM" },
      { key: "losers:3", dayLabel: "Day 1", timeLabel: "5:15 PM" },
      { key: "winners:4", dayLabel: "Day 2", timeLabel: "1:45 PM" },
      { key: "losers:4", dayLabel: "Day 2", timeLabel: "12:00 PM" },
      { key: "losers:5", dayLabel: "Day 2", timeLabel: "1:45 PM" },
      { key: "losers:6", dayLabel: "Day 2", timeLabel: "3:30 PM" },
      { key: "grand-final:1", dayLabel: "Day 2", timeLabel: "5:15 PM" },
    ]);
    expect(scheduled).toHaveLength(22);
    expect(scheduled.map((match) => match.publicMatchNumber)).toEqual(
      Array.from({ length: 22 }, (_, index) => index + 1)
    );
    expect(snapshot.matches.filter((match) => match.autoAdvance)).toHaveLength(8);
    expect(snapshot.matches.filter((match) => match.autoAdvance && match.schedule)).toHaveLength(0);
    expect(scheduled.find((match) => match.publicMatchNumber === 1)).toMatchObject({
      groupName: "Winners",
      roundNumber: 1,
      number: 2,
      schedule: { dayLabel: "Day 1", timeLabel: "12:00 PM", casterIds: [3] },
    });
    expect(scheduled.find((match) => match.publicMatchNumber === 11)).toMatchObject({
      groupName: "Losers",
      roundNumber: 2,
      number: 1,
      slotLabels: { opponent1: "Loser of 8", opponent2: "Loser of 1" },
    });
    expect(scheduled.find((match) => match.publicMatchNumber === 12)).toMatchObject({
      slotLabels: { opponent1: "Loser of 7", opponent2: "Loser of 2" },
    });
    expect(scheduled.find((match) => match.publicMatchNumber === 13)).toMatchObject({
      slotLabels: { opponent1: "Loser of 3", opponent2: "Loser of 6" },
    });
    expect(scheduled.find((match) => match.publicMatchNumber === 14)).toMatchObject({
      slotLabels: { opponent1: "Loser of 4", opponent2: "Loser of 5" },
    });
    expect(scheduled.find((match) => match.publicMatchNumber === 21)).toMatchObject({
      schedule: { dayLabel: "Day 2", timeLabel: "3:30 PM", casterIds: [1, 2] },
      casters: [
        { id: 1, label: "Yukari", color: "purple" },
        { id: 2, label: "Supa", color: "green" },
      ],
      slotLabels: { opponent1: "Loser of 17", opponent2: "Winner of 20" },
    });
    expect(scheduled.find((match) => match.publicMatchNumber === 22)).toMatchObject({
      groupName: "Grand Final",
      schedule: { dayLabel: "Day 2", timeLabel: "5:15 PM", casterIds: [1, 2] },
      casters: [
        { id: 1, label: "Yukari", color: "purple" },
        { id: 2, label: "Supa", color: "green" },
      ],
      slotLabels: { opponent1: "Winner of 17", opponent2: "Winner of 21" },
    });
    // Ace shares Lemon's slots, so both resolved casters and highlight tokens
    // stay attached to the public schedule with no TBD fallback.
    expect(scheduled.find((match) => match.publicMatchNumber === 13)).toMatchObject({
      schedule: { casterIds: [6, 7] },
      casters: [
        { id: 6, label: "Lemon", color: "yellow" },
        { id: 7, label: "Ace", color: "blue" },
      ],
    });
    expect(scheduled.find((match) => match.publicMatchNumber === 16)).toMatchObject({
      schedule: { casterIds: [6, 7] },
    });
    expect(JSON.stringify(snapshot.schedule)).not.toContain("To Be Determined");
  });

  test("routes scored teams into the announced public match slots", async () => {
    const store = loadStore();
    store.resetMemoryTourneyBracketStoreForTests();
    await addTeams(
      store,
      Array.from({ length: 12 }, (_, index) => `Team ${index + 1}`)
    );
    let snapshot = await store.generateTourneyBracket({
      actorUsername: "serviroo",
      env,
    });
    const outcomes = new Map();

    const getPublicMatch = (matchNumber) => {
      const current = snapshot.matches.find(
        (match) => match.publicMatchNumber === matchNumber
      );
      expect(current).toBeDefined();
      return current;
    };
    const expectSides = (matchNumber, opponent1, opponent2) => {
      expect(getPublicMatch(matchNumber)).toMatchObject({
        opponent1: { name: opponent1 },
        opponent2: { name: opponent2 },
      });
    };
    const score = async (matchNumber) => {
      const current = getPublicMatch(matchNumber);
      expect(current.statusLabel).toBe("Ready");
      outcomes.set(matchNumber, {
        winner: current.opponent1.name,
        loser: current.opponent2.name,
      });
      snapshot = await store.scoreTourneyBracketMatch({
        matchId: current.id,
        opponent1Score: current.targetScore,
        opponent2Score: 1,
        actorUsername: "serviroo",
        env,
      });
    };

    for (const matchNumber of [1, 2, 3, 4, 5, 6, 7, 8]) {
      await score(matchNumber);
    }

    expectSides(11, outcomes.get(8).loser, outcomes.get(1).loser);
    expectSides(12, outcomes.get(7).loser, outcomes.get(2).loser);
    expectSides(13, outcomes.get(3).loser, outcomes.get(6).loser);
    expectSides(14, outcomes.get(4).loser, outcomes.get(5).loser);

    for (const matchNumber of [9, 10, 11, 12, 13, 14]) {
      await score(matchNumber);
    }

    expectSides(15, outcomes.get(11).winner, outcomes.get(12).winner);
    expectSides(16, outcomes.get(13).winner, outcomes.get(14).winner);
    expectSides(17, outcomes.get(9).winner, outcomes.get(10).winner);

    await score(15);
    await score(16);
    expectSides(18, outcomes.get(9).loser, outcomes.get(15).winner);
    expectSides(19, outcomes.get(10).loser, outcomes.get(16).winner);

    await score(17);
    await score(18);
    await score(19);
    expectSides(20, outcomes.get(18).winner, outcomes.get(19).winner);

    await score(20);
    expectSides(21, outcomes.get(17).loser, outcomes.get(20).winner);

    await score(21);
    expectSides(22, outcomes.get(17).winner, outcomes.get(21).winner);
  });

  test("repairs the live lower routing without resetting upstream results", async () => {
    const store = loadStore();
    store.resetMemoryTourneyBracketStoreForTests();
    await addTeams(
      store,
      Array.from({ length: 12 }, (_, index) => `Team ${index + 1}`)
    );
    let snapshot = await store.generateTourneyBracket({
      actorUsername: "serviroo",
      env,
    });
    const getMatch = (matchNumber) =>
      snapshot.matches.find((match) => match.publicMatchNumber === matchNumber);
    const complete = async (matchNumber) => {
      const match = getMatch(matchNumber);
      snapshot = await store.scoreTourneyBracketMatch({
        matchId: match.id,
        opponent1Score: match.targetScore,
        opponent2Score: 1,
        actorUsername: "serviroo",
        env,
      });
    };

    for (const matchNumber of [1, 2, 3, 4, 7, 8]) {
      await complete(matchNumber);
    }
    for (const [matchNumber, scores] of [[5, [2, 1]], [6, [2, 2]]]) {
      const match = getMatch(matchNumber);
      snapshot = await store.startTourneyBracketMatch({
        matchId: match.id,
        actorUsername: "yukari",
        env,
      });
      snapshot = await store.scoreTourneyBracketMatch({
        matchId: match.id,
        opponent1Score: scores[0],
        opponent2Score: scores[1],
        actorUsername: "yukari",
        env,
      });
    }

    const outcomes = Object.fromEntries(
      [1, 2, 3, 4, 7, 8].map((matchNumber) => {
        const match = getMatch(matchNumber);
        return [matchNumber, {
          winner: match.opponent1.name,
          loser: match.opponent2.name,
        }];
      })
    );
    const liveScores = [5, 6].map((matchNumber) => {
      const match = getMatch(matchNumber);
      return {
        matchNumber,
        status: match.statusLabel,
        opponent1Score: match.opponent1.score,
        opponent2Score: match.opponent2.score,
      };
    });

    const memory = globalThis.__rooTourneyBracketStore;
    const lower = [11, 12, 13, 14].map((matchNumber) => {
      const publicMatch = getMatch(matchNumber);
      return memory.entities.match.find((match) => match.id === publicMatch.id);
    });
    const desiredOpponent1 = lower.map((match) =>
      JSON.parse(JSON.stringify(match.opponent1))
    );
    [3, 2, 0, 1].forEach((sourceIndex, index) => {
      lower[index].opponent1 = JSON.parse(
        JSON.stringify(desiredOpponent1[sourceIndex])
      );
    });
    memory.entities.stage[0].settings.seedOrdering[2] = "natural";
    snapshot = await store.getTourneyBracketSnapshot({ env });

    expect(getMatch(11)).toMatchObject({
      opponent1: { name: "TBD" },
      opponent2: { name: outcomes[1].loser },
    });
    expect(getMatch(12)).toMatchObject({
      opponent1: { name: "TBD" },
      opponent2: { name: outcomes[2].loser },
    });
    expect(getMatch(13)).toMatchObject({
      opponent1: { name: outcomes[8].loser },
      opponent2: { name: outcomes[3].loser },
    });
    expect(getMatch(14)).toMatchObject({
      opponent1: { name: outcomes[7].loser },
      opponent2: { name: outcomes[4].loser },
    });

    snapshot = await store.repairTourneyLowerBracketRouting({
      actorUsername: "serviroo",
      env,
    });
    expect(getMatch(11)).toMatchObject({
      opponent1: { name: outcomes[8].loser },
      opponent2: { name: outcomes[1].loser },
    });
    expect(getMatch(12)).toMatchObject({
      opponent1: { name: outcomes[7].loser },
      opponent2: { name: outcomes[2].loser },
    });
    expect(getMatch(13)).toMatchObject({
      opponent1: { name: "TBD" },
      opponent2: { name: outcomes[3].loser },
    });
    expect(getMatch(14)).toMatchObject({
      opponent1: { name: "TBD" },
      opponent2: { name: outcomes[4].loser },
    });
    expect([5, 6].map((matchNumber) => {
      const match = getMatch(matchNumber);
      return {
        matchNumber,
        status: match.statusLabel,
        opponent1Score: match.opponent1.score,
        opponent2Score: match.opponent2.score,
      };
    })).toEqual(liveScores);
    expect(snapshot.audit[0].action).toBe("bracket.lower-routing.repair");

    const matchFiveLoser = getMatch(5).opponent2.name;
    const matchSixLoser = getMatch(6).opponent2.name;
    await complete(5);
    await complete(6);
    expect(getMatch(13)).toMatchObject({
      opponent1: { name: outcomes[3].loser },
      opponent2: { name: matchSixLoser },
    });
    expect(getMatch(14)).toMatchObject({
      opponent1: { name: outcomes[4].loser },
      opponent2: { name: matchFiveLoser },
    });

    memory.entities.stage[0].settings.seedOrdering[2] = "natural";
    snapshot = await store.startTourneyBracketMatch({
      matchId: getMatch(11).id,
      actorUsername: "yukari",
      env,
    });
    await expect(
      store.repairTourneyLowerBracketRouting({
        actorUsername: "serviroo",
        env,
      })
    ).rejects.toMatchObject({ status: 409 });
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

  test("starts live, publishes partial scores, and completes at the Bo5 target", async () => {
    const { store, snapshot } = await generateFourTeamBracket();
    const first = snapshot.matches.find(
      (match) => match.groupName === "Winners" && match.roundNumber === 1
    );

    let updated = await store.startTourneyBracketMatch({
      matchId: first.id,
      actorUsername: "yukari",
      env,
    });
    expect(updated.matches.find((match) => match.id === first.id)).toMatchObject({
      statusLabel: "Running",
      opponent1: { score: 0, result: "" },
      opponent2: { score: 0, result: "" },
    });

    updated = await store.scoreTourneyBracketMatch({
      matchId: first.id,
      opponent1Score: 1,
      opponent2Score: 0,
      actorUsername: "yukari",
      env,
    });
    expect(updated.matches.find((match) => match.id === first.id)).toMatchObject({
      statusLabel: "Running",
      opponent1: { score: 1, result: "" },
      opponent2: { score: 0, result: "" },
    });

    updated = await store.scoreTourneyBracketMatch({
      matchId: first.id,
      opponent1Score: 3,
      opponent2Score: 2,
      actorUsername: "yukari",
      env,
    });
    expect(updated.matches.find((match) => match.id === first.id)).toMatchObject({
      statusLabel: "Completed",
      opponent1: { score: 3, result: "win" },
      opponent2: { score: 2, result: "loss" },
    });
    expect(updated.audit.map((event) => event.action)).toEqual(
      expect.arrayContaining(["match.start", "match.score.update", "match.score"])
    );
  });

  test("persists per-match broadcast state without changing scores", async () => {
    const { store, snapshot } = await generateFourTeamBracket();
    const first = snapshot.matches.find((match) => match.statusLabel === "Ready");

    const updated = await store.updateTourneyMatchBroadcast({
      matchId: first.id,
      mapName: "Ilios",
      mapMode: "Control",
      pickedBy: "opponent2",
      opponent1Ban: "Ana",
      opponent2Ban: "Tracer",
      displayMode: "bans",
      actorUsername: "yukari",
      env,
    });

    expect(updated.matches.find((match) => match.id === first.id)).toMatchObject({
      opponent1: { score: "" },
      opponent2: { score: "" },
      broadcast: {
        matchId: first.id,
        mapName: "Ilios",
        mapMode: "Control",
        pickedBy: "opponent2",
        opponent1Ban: "Ana",
        opponent2Ban: "Tracer",
        displayMode: "bans",
        updatedBy: "yukari",
      },
    });
    expect(updated.audit[0]).toMatchObject({
      action: "match.broadcast.update",
      matchId: first.id,
      actorUsername: "yukari",
    });

    await expect(
      store.updateTourneyMatchBroadcast({
        matchId: first.id,
        displayMode: "fullscreen",
        actorUsername: "yukari",
        env,
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  test("keeps Grand Final live until one side reaches four wins", async () => {
    const { store } = await generateFourTeamBracket();
    let snapshot = await store.getTourneyBracketSnapshot({ env });

    while (true) {
      const grandFinal = snapshot.matches.find(
        (match) => match.groupName === "Grand Final"
      );
      if (grandFinal?.statusLabel === "Ready") break;
      const ready = snapshot.matches.find(
        (match) => match.statusLabel === "Ready" && match.groupName !== "Grand Final"
      );
      expect(ready).toBeDefined();
      snapshot = await store.scoreTourneyBracketMatch({
        matchId: ready.id,
        opponent1Score: ready.targetScore,
        opponent2Score: 0,
        actorUsername: "serviroo",
        env,
      });
    }

    const final = snapshot.matches.find(
      (match) => match.groupName === "Grand Final"
    );
    expect(final.targetScore).toBe(4);
    await store.startTourneyBracketMatch({
      matchId: final.id,
      actorUsername: "yukari",
      env,
    });
    snapshot = await store.scoreTourneyBracketMatch({
      matchId: final.id,
      opponent1Score: 3,
      opponent2Score: 2,
      actorUsername: "yukari",
      env,
    });
    expect(snapshot.matches.find((match) => match.id === final.id).statusLabel).toBe(
      "Running"
    );

    snapshot = await store.scoreTourneyBracketMatch({
      matchId: final.id,
      opponent1Score: 4,
      opponent2Score: 2,
      actorUsername: "yukari",
      env,
    });
    expect(snapshot.matches.find((match) => match.id === final.id)).toMatchObject({
      statusLabel: "Completed",
      opponent1: { score: 4, result: "win" },
      opponent2: { score: 2, result: "loss" },
    });
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
