const loadStore = () => {
  jest.resetModules();
  return require("../server/tourney/playerStore.js");
};

const loadAuth = () => {
  jest.resetModules();
  return require("../server/tourney/auth.js");
};

const env = {
  NODE_ENV: "production",
  TOURNEY_SESSION_SECRET: "test_tourney_session_secret",
  TOURNEY_PLAYER_STORE_MODE: "memory",
  TOURNEY_ACCOUNTS_JSON: "[]",
};

const basePayload = {
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
  notes: "Can sub if needed.",
};

const approvers = [
  {
    username: "serviroo",
    email: "serviroo@rooindustries.com",
    role: "owner",
    version: "7",
  },
  {
    username: "yukari",
    email: "yukariipoi@gmail.com",
    role: "caster",
    version: "1",
  },
];

describe("tourney player store", () => {
  afterEach(() => {
    const store = require("../server/tourney/playerStore.js");
    store.resetMemoryTourneyPlayerStoreForTests();
    jest.resetModules();
  });

  test("creates pending registrations with per-approver decision tokens and duplicate Discord protection", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();

    const created = await store.createPendingTourneyPlayer({
      payload: basePayload,
      recipients: approvers,
      env,
    });

    expect(created.player).toMatchObject({
      email: "playerone@example.com",
      status: "pending",
      discord: "PlayerOne#1234",
      displayName: "Player One",
      timezone: "Eastern Time (ET)",
      twitchUsername: "playerone",
      teamName: "",
    });
    expect(created.player.username).toMatch(/^[a-z0-9_.-]{3,24}$/);
    expect(created.player.username).not.toBe("PlayerOne#1234");
    expect(
      store.validateTourneyPlayerPayload({
        ...basePayload,
        username: "legacy-visible-name",
      }).value.username
    ).not.toBe("legacy-visible-name");
    expect(created.tokens).toHaveLength(4);
    expect(JSON.stringify(created)).not.toContain("player-password");
    expect(
      created.tokens.some(
        (token) =>
          token.recipient_email === "yukariipoi@gmail.com" &&
          token.recipient_version === "1" &&
          token.purpose === "approve"
      )
    ).toBe(true);

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          email: "playertwo@example.com",
          discord: " playerone#1234 ",
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("Discord is already registered.");
  });

  test("rejects ranks below Master", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          rank: "Diamond",
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("Choose a rank.");
  });

  test("rejects Top 500 as a standalone rank", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          rank: "Top 500",
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("Choose a rank.");
  });

  test("requires display name, password confirmation, timezone, Twitch username, and August availability", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          displayName: "",
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("Display Name is required.");

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          passwordConfirm: "wrong-password",
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("Passwords must match.");

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          timezone: "",
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("Choose a timezone.");

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          timezone: "Mars Standard Time",
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("Choose a timezone.");

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          email: "notwitch@example.com",
          discord: "NoTwitch#1234",
          twitchUsername: "",
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("Enter a valid Twitch username.");

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          email: "urltwitch@example.com",
          discord: "UrlTwitch#1234",
          twitchUsername: "https://www.twitch.tv/playerone",
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("Enter a valid Twitch username.");

    store.resetMemoryTourneyPlayerStoreForTests();

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          availableAug12: false,
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("You must confirm August 1st and 2nd availability.");
  });

  test("approves players, allows Discord or email login, and invalidates sessions after kick", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();
    const created = await store.createPendingTourneyPlayer({
      payload: basePayload,
      recipients: approvers,
      env,
    });
    const approveToken = created.tokens.find(
      (token) =>
        token.purpose === "approve" &&
        token.recipient_email === "yukariipoi@gmail.com"
    );
    const tokenRow = await store.getRegistrationDecisionToken({
      token: approveToken.token,
      purpose: "approve",
      env,
    });

    const approved = await store.applyRegistrationDecision({
      tokenHash: store.hashTourneyToken(approveToken.token),
      playerId: tokenRow.player_id,
      purpose: "approve",
      actorUsername: "yukari",
      env,
    });

    expect(approved).toMatchObject({
      discord: "PlayerOne#1234",
      status: "approved",
      approvedBy: "yukari",
    });
    await expect(
      store.getRegistrationDecisionToken({
        token: approveToken.token,
        purpose: "approve",
        env,
      })
    ).resolves.toBeNull();
    await expect(store.listApprovedTourneyPlayers({ env })).resolves.toHaveLength(1);
    const publicPlayers = await store.listApprovedTourneyPlayers({ env });
    expect(publicPlayers[0]).toMatchObject({
      displayName: "Player One",
      rolePlay: "Support",
      teamName: "",
      twitchUsername: "playerone",
    });
    expect(publicPlayers[0]).not.toHaveProperty("discord");
    expect(publicPlayers[0]).not.toHaveProperty("email");
    expect(publicPlayers[0]).not.toHaveProperty("battlenet");
    expect(publicPlayers[0]).not.toHaveProperty("timezone");
    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "playerone@example.com",
        password: "player-password",
        env,
      })
    ).resolves.toMatchObject({
      ok: true,
      account: { username: approved.username, role: "player" },
    });

    const auth = loadAuth();
    const login = await store.verifyTourneyPlayerCredentials({
      login: "PlayerOne#1234",
      password: "player-password",
      env,
    });
    const sessionToken = auth.createTourneySessionToken({
      account: login.account,
      env,
    });
    await expect(
      auth.readTourneySessionFromStore({
        token: sessionToken,
        env,
        readPersistedAccountsJson: async () => "[]",
      })
    ).resolves.toMatchObject({
      username: approved.username,
      role: "player",
    });

    await store.kickTourneyPlayer({
      playerId: approved.id,
      actorUsername: "serviroo",
      env,
    });
    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "PlayerOne#1234",
        password: "player-password",
        env,
      })
    ).resolves.toMatchObject({
      ok: false,
      account: null,
      reason: "suspended",
    });
    await expect(
      auth.readTourneySessionFromStore({
        token: sessionToken,
        env,
        readPersistedAccountsJson: async () => "[]",
      })
    ).resolves.toBeNull();
  });

  test("resets approved player passwords and rejects the old password", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();
    await store.createApprovedTourneyPlayer({
      payload: basePayload,
      actorUsername: "serviroo",
      env,
    });

    const reset = await store.createTourneyResetToken({
      login: "PlayerOne#1234",
      env,
    });
    expect(reset.player.discord).toBe("PlayerOne#1234");

    await store.resetTourneyPlayerPassword({
      token: reset.token,
      password: "new-player-password",
      env,
    });
    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "PlayerOne#1234",
        password: "player-password",
        env,
      })
    ).resolves.toMatchObject({ ok: false, account: null });
    await expect(
      store.verifyTourneyPlayerCredentials({
        login: "PlayerOne#1234",
        password: "new-player-password",
        env,
      })
    ).resolves.toMatchObject({
      ok: true,
      account: { role: "player" },
    });
    await expect(
      store.resetTourneyPlayerPassword({
        token: reset.token,
        password: "another-password",
        env,
      })
    ).rejects.toThrow("Invalid or expired reset link.");
  });

  test("updates player-facing details for roster display", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();
    const player = await store.createApprovedTourneyPlayer({
      payload: basePayload,
      actorUsername: "serviroo",
      env,
    });

    await expect(
      store.updateTourneyPlayerDetails({
        playerId: player.id,
        payload: {
          displayName: "Skinz",
          teamName: "Team Cyber",
          twitchUsername: "skinz_ow",
        },
        actorUsername: "yukari",
        env,
      })
    ).resolves.toMatchObject({
      displayName: "Skinz",
      teamName: "Team Cyber",
      twitchUsername: "skinz_ow",
    });

    const publicPlayers = await store.listApprovedTourneyPlayers({ env });
    expect(publicPlayers[0]).toEqual({
      id: player.id,
      displayName: "Skinz",
      rolePlay: "Support",
      teamName: "Team Cyber",
      twitchUsername: "skinz_ow",
    });
  });
});
