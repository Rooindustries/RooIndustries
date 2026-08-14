const loadApi = () => {
  jest.resetModules();
  return require("../server/tourney/publicBracketApi.js");
};

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
  await store.generateTourneyBracket({ actorUsername: "serviroo", env });
  return store;
};

const makeMatch = (overrides = {}) => ({
  id: overrides.id ?? 1,
  number: overrides.number ?? 1,
  roundNumber: overrides.roundNumber ?? 1,
  groupNumber: 1,
  groupName: "Winners",
  label: "Winners R1 M1",
  displayLabel: "Winners Quarterfinal 1",
  status: 2,
  statusLabel: "Ready",
  bestOf: 5,
  targetScore: 3,
  opponent1: {
    side: "opponent1",
    participantId: 11,
    teamId: "team_1",
    name: "Alpha",
    score: "",
    result: "",
    forfeit: false,
    status: "active",
  },
  opponent2: {
    side: "opponent2",
    participantId: 12,
    teamId: "team_2",
    name: "Bravo",
    score: "",
    result: "",
    forfeit: false,
    status: "active",
  },
  nextLabels: [],
  ...overrides,
});

describe("tourney public bracket API contract", () => {
  afterEach(() => {
    const store = require("../server/tourney/bracketStore.js");
    store.resetMemoryTourneyBracketStoreForTests();
    jest.resetModules();
  });

  test("builds a stable versioned bracket response from a generated bracket", async () => {
    const api = loadApi();
    const store = await generateFourTeamBracket();
    const snapshot = await store.getTourneyBracketSnapshot({ env });

    const body = api.buildPublicBracketResponse(snapshot);

    expect(body.ok).toBe(true);
    expect(body.apiVersion).toBe("1");
    expect(body.version).toMatch(/^[a-f0-9]{16}$/);
    expect(body.generated).toBe(true);
    expect(body.teams.map((team) => team.name)).toEqual(
      expect.arrayContaining(["Alpha", "Bravo", "Charlie", "Delta"])
    );
    expect(body.teams[0]).toEqual({
      id: expect.any(String),
      name: expect.any(String),
      seed: expect.any(Number),
      status: expect.any(String),
    });
    expect(body.groups.map((group) => group.key)).toEqual([
      "winners",
      "losers",
      "grand-final",
    ]);
    const winnersRounds = body.groups[0].rounds;
    expect(winnersRounds.length).toBeGreaterThan(0);
    expect(winnersRounds[0].matches[0]).toMatchObject({
      group: "winners",
      status: expect.any(String),
      statusCode: expect.any(Number),
      live: expect.any(Boolean),
      completed: expect.any(Boolean),
      bestOf: 5,
      opponents: [
        expect.objectContaining({ slot: 1, name: expect.any(String) }),
        expect.objectContaining({ slot: 2 }),
      ],
    });
  });

  test("publishes the official schedule and match annotations", async () => {
    const api = loadApi();
    const store = loadStore();
    store.resetMemoryTourneyBracketStoreForTests();
    const snapshot = await store.getTourneyBracketSnapshot({
      env: { TOURNEY_BRACKET_PREVIEW_FIXTURE: "12x6" },
    });

    const body = api.buildPublicBracketResponse(snapshot);
    const scheduled = body.matches.filter((match) => match.publicMatchNumber !== null);

    expect(body.schedule).toMatchObject({
      timeZone: "PST",
      eventDates: ["2026-08-15", "2026-08-16"],
    });
    expect(body.schedule.rounds).toHaveLength(10);
    expect(scheduled).toHaveLength(22);
    expect(scheduled.map((match) => match.publicMatchNumber).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 22 }, (_, index) => index + 1)
    );
    expect(body.matches.filter((match) => match.autoAdvance)).toHaveLength(8);
    expect(scheduled.find((match) => match.publicMatchNumber === 9)).toMatchObject({
      schedule: { stageLabel: "Round 3", dayLabel: "Day 1", timeLabel: "3:30 PM" },
      casters: [{ id: 1, label: "Yukari + SpankyCheeze", color: "purple" }],
      slotLabels: { opponent1: "Winner of 5", opponent2: "Winner of 6" },
    });
    expect(scheduled.find((match) => match.publicMatchNumber === 22)).toMatchObject({
      group: "grand-final",
      schedule: { stageLabel: "Finals", dayLabel: "Day 2", timeLabel: "5:15 PM" },
      casters: [
        { id: 1, label: "Yukari", color: "purple" },
        { id: 2, label: "Supa", color: "green" },
      ],
    });
  });

  test("version changes when a match is scored", async () => {
    const api = loadApi();
    const store = await generateFourTeamBracket();
    const before = api.buildPublicBracketResponse(
      await store.getTourneyBracketSnapshot({ env })
    );

    const ready = before.matches.find((match) => match.status === "ready");
    expect(ready).toBeTruthy();
    await store.scoreTourneyBracketMatch({
      matchId: ready.id,
      opponent1Score: 3,
      opponent2Score: 1,
      actorUsername: "serviroo",
      env,
    });

    const after = api.buildPublicBracketResponse(
      await store.getTourneyBracketSnapshot({ env })
    );
    expect(after.version).not.toBe(before.version);
    const scored = after.matches.find((match) => match.id === ready.id);
    expect(scored.status).toBe("completed");
    expect(scored.completed).toBe(true);
    expect(scored.opponents[0]).toMatchObject({ score: 3, winner: true });
    expect(scored.opponents[1]).toMatchObject({ score: 1, winner: false });
  });

  test("maps every engine status code to a public slug", () => {
    const api = loadApi();
    const labels = {
      0: "locked",
      1: "waiting",
      2: "ready",
      3: "running",
      4: "completed",
      5: "archived",
      6: "cancelled",
    };
    for (const [code, slug] of Object.entries(labels)) {
      const body = api.buildPublicMatchesResponse(
        { ok: true, generated: true, teams: [], matches: [makeMatch({ status: Number(code) })] },
        {}
      );
      expect(body.matches[0].status).toBe(slug);
      expect(body.matches[0].live).toBe(slug === "running");
    }
  });

  test("normalizes scores, forfeits, and winners on opponents", () => {
    const api = loadApi();
    const match = makeMatch({
      status: 4,
      opponent1: {
        side: "opponent1",
        participantId: 11,
        teamId: "team_1",
        name: "Alpha",
        score: 3,
        result: "win",
        forfeit: false,
        status: "active",
      },
      opponent2: {
        side: "opponent2",
        participantId: 12,
        teamId: "team_2",
        name: "Bravo",
        score: 1,
        result: "loss",
        forfeit: true,
        status: "active",
      },
    });
    const body = api.buildPublicMatchesResponse(
      { ok: true, generated: true, teams: [], matches: [match] },
      {}
    );
    expect(body.matches[0].opponents[0]).toMatchObject({
      score: 3,
      result: "win",
      winner: true,
      forfeit: false,
    });
    expect(body.matches[0].opponents[1]).toMatchObject({
      score: 1,
      winner: false,
      forfeit: true,
    });

    const unset = api.buildPublicMatchesResponse(
      { ok: true, generated: true, teams: [], matches: [makeMatch()] },
      {}
    );
    expect(unset.matches[0].opponents[0].score).toBeNull();
  });

  test("filters matches by status codes and group", () => {
    const api = loadApi();
    const snapshot = {
      ok: true,
      generated: true,
      teams: [],
      matches: [
        makeMatch({ id: 1, status: 2, groupName: "Winners" }),
        makeMatch({ id: 2, status: 3, groupName: "Winners", number: 2 }),
        makeMatch({ id: 3, status: 3, groupName: "Losers", groupNumber: 2 }),
      ],
    };

    const running = api.buildPublicMatchesResponse(snapshot, { statusCodes: [3] });
    expect(running.count).toBe(2);
    expect(running.matches.every((match) => match.status === "running")).toBe(true);

    const losersOnly = api.buildPublicMatchesResponse(snapshot, {
      statusCodes: [3],
      groupName: "Losers",
    });
    expect(losersOnly.count).toBe(1);
    expect(losersOnly.matches[0].id).toBe(3);
  });

  test("builds the live feed from running matches and ready up-next matches", () => {
    const api = loadApi();
    const snapshot = {
      ok: true,
      generated: true,
      teams: [],
      matches: [
        makeMatch({ id: 1, status: 2, groupName: "Losers", groupNumber: 2, roundNumber: 1 }),
        makeMatch({ id: 2, status: 3, groupName: "Winners", roundNumber: 2, number: 1 }),
        makeMatch({ id: 3, status: 2, groupName: "Winners", roundNumber: 1, number: 2 }),
        makeMatch({ id: 4, status: 4, groupName: "Winners", roundNumber: 1, number: 1 }),
        makeMatch({ id: 5, status: 2, groupName: "Grand Final", groupNumber: 3 }),
      ],
    };

    const feed = api.buildPublicLiveResponse(snapshot, { limit: 2 });

    expect(feed.live.map((match) => match.id)).toEqual([2]);
    expect(feed.upNext.map((match) => match.id)).toEqual([3, 1]);
    expect(feed.live[0].live).toBe(true);
  });

  test("clamps the live feed limit", () => {
    const api = loadApi();
    const snapshot = {
      ok: true,
      generated: true,
      teams: [],
      matches: [1, 2, 3, 4].map((id) => makeMatch({ id, status: 2 })),
    };
    expect(api.buildPublicLiveResponse(snapshot, { limit: 1 }).upNext).toHaveLength(1);
    expect(api.buildPublicLiveResponse(snapshot, { limit: 99 }).upNext).toHaveLength(4);
    expect(api.buildPublicLiveResponse(snapshot, { limit: "x" }).upNext).toHaveLength(3);
  });

  test("pins the live feed to one match or one team for parallel tables", () => {
    const api = loadApi();
    const withTeams = (a, b) => ({
      opponent1: { side: "opponent1", teamId: a[0], name: a[1], score: "", result: "", forfeit: false },
      opponent2: { side: "opponent2", teamId: b[0], name: b[1], score: "", result: "", forfeit: false },
    });
    const snapshot = {
      ok: true,
      generated: true,
      teams: [],
      matches: [
        makeMatch({ id: 1, status: 3, number: 1, ...withTeams(["team_1", "Alpha"], ["team_2", "Bravo"]) }),
        makeMatch({ id: 2, status: 3, number: 2, ...withTeams(["team_3", "Charlie"], ["team_4", "Delta"]) }),
        makeMatch({ id: 3, status: 2, number: 3, ...withTeams(["team_3", "Charlie"], ["team_5", "Echo"]) }),
      ],
    };

    // Default: every running match, bracket order.
    expect(api.buildPublicLiveResponse(snapshot).live.map((m) => m.id)).toEqual([1, 2]);

    // Pin by match id: only that match, even while others run alongside it.
    expect(api.buildPublicLiveResponse(snapshot, { matchId: "2" }).live.map((m) => m.id)).toEqual([2]);
    expect(api.buildPublicLiveResponse(snapshot, { matchId: "2" }).upNext).toEqual([]);

    // Pin to a ready match: shows as up-next instead of live.
    const pinnedReady = api.buildPublicLiveResponse(snapshot, { matchId: "3" });
    expect(pinnedReady.live).toEqual([]);
    expect(pinnedReady.upNext.map((m) => m.id)).toEqual([3]);

    // Unknown pin: the strip goes idle rather than showing another table.
    const pinnedGone = api.buildPublicLiveResponse(snapshot, { matchId: "99" });
    expect(pinnedGone.live).toEqual([]);
    expect(pinnedGone.upNext).toEqual([]);

    // Follow a team by name (case-insensitive) or by team id.
    expect(api.buildPublicLiveResponse(snapshot, { team: "charlie" }).live.map((m) => m.id)).toEqual([2]);
    expect(api.buildPublicLiveResponse(snapshot, { team: "charlie" }).upNext.map((m) => m.id)).toEqual([3]);
    expect(api.buildPublicLiveResponse(snapshot, { team: "team_1" }).live.map((m) => m.id)).toEqual([1]);
    expect(api.buildPublicLiveResponse(snapshot, { team: "Nobody" }).live).toEqual([]);
  });

  test("never reports a result on participant-less bye slots", async () => {
    const api = loadApi();
    const store = loadStore();
    store.resetMemoryTourneyBracketStoreForTests();
    await addTeams(store, [
      "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot",
      "Golf", "Hotel", "India", "Juliett", "Kilo", "Lima",
    ]);
    await store.generateTourneyBracket({ actorUsername: "serviroo", env });
    const snapshot = await store.getTourneyBracketSnapshot({ env });

    // The engine pre-stamps result: "win" on lower-bracket R1 bye slots at
    // creation time; empty slots must surface no result at either layer.
    const emptySides = snapshot.matches
      .flatMap((match) => [match.opponent1, match.opponent2])
      .filter((side) => !side.teamId);
    expect(emptySides.length).toBeGreaterThan(0);
    expect(emptySides.every((side) => side.result === "")).toBe(true);

    const body = api.buildPublicBracketResponse(snapshot);
    const emptyApiSides = body.matches
      .flatMap((match) => match.opponents)
      .filter((side) => !side.teamId);
    expect(emptyApiSides.length).toBeGreaterThan(0);
    expect(
      emptyApiSides.every((side) => side.result === "" && side.winner === false)
    ).toBe(true);
  });

  test("parses status filter slugs and codes, rejecting unknown values", () => {
    const api = loadApi();
    expect(api.parseStatusFilter("running,ready")).toEqual({
      ok: true,
      codes: [3, 2],
    });
    expect(api.parseStatusFilter("3")).toEqual({ ok: true, codes: [3] });
    expect(api.parseStatusFilter("")).toEqual({ ok: true, codes: [] });
    expect(api.parseStatusFilter("bogus")).toEqual({ ok: false, codes: [] });
    expect(api.parseStatusFilter("9")).toEqual({ ok: false, codes: [] });
  });

  test("normalizes group filter aliases", () => {
    const api = loadApi();
    expect(api.normalizeGroupFilter("winners")).toEqual({ ok: true, groupName: "Winners" });
    expect(api.normalizeGroupFilter("Lower")).toEqual({ ok: true, groupName: "Losers" });
    expect(api.normalizeGroupFilter("grand_final")).toEqual({ ok: true, groupName: "Grand Final" });
    expect(api.normalizeGroupFilter("")).toEqual({ ok: true, groupName: "" });
    expect(api.normalizeGroupFilter("playoffs").ok).toBe(false);
  });
});
