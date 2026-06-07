const loadStores = () => {
  jest.resetModules();
  return {
    players: require("../server/tourney/playerStore.js"),
    records: require("../server/tourney/appealPayoutStore.js"),
  };
};

const env = {
  TOURNEY_PLAYER_STORE_MODE: "memory",
  TOURNEY_APPEAL_PAYOUT_STORE_MODE: "memory",
  TOURNEY_DATABASE_MODE: "memory",
};

const playerPayload = {
  email: "playerone@example.com",
  password: "player-password",
  passwordConfirm: "player-password",
  discord: "PlayerOne#1234",
  displayName: "Player One",
  battlenet: "PlayerOne#9876",
  rank: "Master",
  rolePlay: "Support",
  timezone: "Eastern Time (ET)",
  twitchUsername: "playerone",
  availableAug12: true,
  notes: "",
};

const adminSession = {
  username: "yukari",
  role: "caster",
};

describe("tourney appeal and payout store", () => {
  afterEach(() => {
    const { players, records } = loadStores();
    players.resetMemoryTourneyPlayerStoreForTests();
    records.resetMemoryTourneyAppealPayoutStoreForTests();
    jest.resetModules();
  });

  test("players submit appeals and admins can review all records", async () => {
    const { players, records } = loadStores();
    players.resetMemoryTourneyPlayerStoreForTests();
    records.resetMemoryTourneyAppealPayoutStoreForTests();

    const player = await players.createApprovedTourneyPlayer({
      payload: playerPayload,
      actorUsername: "serviroo",
      env,
    });
    const other = await players.createApprovedTourneyPlayer({
      payload: {
        ...playerPayload,
        email: "playertwo@example.com",
        discord: "PlayerTwo#1234",
        displayName: "Player Two",
        twitchUsername: "playertwo",
      },
      actorUsername: "serviroo",
      env,
    });
    const playerSession = {
      username: player.username,
      role: "player",
      playerId: player.id,
    };
    const otherSession = {
      username: other.username,
      role: "player",
      playerId: other.id,
    };

    const appeal = await records.createTourneyAppeal({
      payload: {
        type: "team-appeal",
        title: "Map ruling",
        teamName: "Team One",
        captainName: "Captain One",
        details: "We need a ruling on the map result.",
      },
      session: playerSession,
      env,
    });
    await records.createTourneyAppeal({
      payload: {
        type: "captain-complaint",
        title: "Captain complaint",
        subjectName: "Captain Two",
        details: "Captain issue details.",
      },
      session: otherSession,
      env,
    });

    await expect(
      records.listTourneyAppealsForSession({ session: playerSession, env })
    ).resolves.toHaveLength(1);
    await expect(
      records.listTourneyAppealsForSession({ session: adminSession, env })
    ).resolves.toHaveLength(2);

    await expect(
      records.updateTourneyAppeal({
        appealId: appeal.id,
        payload: { status: "upheld", ruling: "Appeal accepted." },
        session: playerSession,
        env,
      })
    ).rejects.toThrow("Not found.");

    await expect(
      records.updateTourneyAppeal({
        appealId: appeal.id,
        payload: { status: "upheld", ruling: "Appeal accepted." },
        session: adminSession,
        env,
      })
    ).resolves.toMatchObject({
      status: "upheld",
      ruling: "Appeal accepted.",
      updatedBy: "yukari",
    });
  });

  test("admins manage payouts and players only see their own payout records", async () => {
    const { players, records } = loadStores();
    players.resetMemoryTourneyPlayerStoreForTests();
    records.resetMemoryTourneyAppealPayoutStoreForTests();

    const player = await players.createApprovedTourneyPlayer({
      payload: playerPayload,
      actorUsername: "serviroo",
      env,
    });
    const other = await players.createApprovedTourneyPlayer({
      payload: {
        ...playerPayload,
        email: "playertwo@example.com",
        discord: "PlayerTwo#1234",
        displayName: "Player Two",
        twitchUsername: "playertwo",
      },
      actorUsername: "serviroo",
      env,
    });
    const playerSession = {
      username: player.username,
      role: "player",
      playerId: player.id,
    };
    const otherSession = {
      username: other.username,
      role: "player",
      playerId: other.id,
    };

    await expect(
      records.upsertTourneyPayout({
        payload: {
          playerId: player.id,
          payoutType: "mvp",
          amountUsd: 100,
          status: "ready",
        },
        session: playerSession,
        env,
      })
    ).rejects.toThrow("Not found.");

    await expect(
      records.upsertTourneyPayout({
        payload: {
          playerId: player.id,
          payoutType: "mvp",
          amountUsd: 100,
          status: "ready",
          payoutEmail: "playerone@example.com",
        },
        session: adminSession,
        env,
      })
    ).resolves.toMatchObject({
      playerId: player.id,
      displayName: "Player One",
      payoutType: "mvp",
      amountUsd: 100,
      status: "ready",
    });

    await expect(
      records.listTourneyPayoutsForSession({ session: playerSession, env })
    ).resolves.toHaveLength(1);
    await expect(
      records.listTourneyPayoutsForSession({ session: otherSession, env })
    ).resolves.toHaveLength(0);
    await expect(
      records.listTourneyPayoutsForSession({ session: adminSession, env })
    ).resolves.toHaveLength(1);
  });
});
