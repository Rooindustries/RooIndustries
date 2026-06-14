const loadStore = () => {
  jest.resetModules();
  return require("../server/tourney/playerStore.js");
};

const loadAuth = () => {
  jest.resetModules();
  return require("../server/tourney/auth.js");
};

const originalFetch = global.fetch;

const env = {
  NODE_ENV: "production",
  TOURNEY_SESSION_SECRET: "test_tourney_session_secret",
  TOURNEY_PLAYER_STORE_MODE: "memory",
  TOURNEY_ACCOUNTS_JSON: "[]",
  TOURNEY_TWITCH_PROFILE_LOOKUP: "0",
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
  acceptedRules: true,
  acceptedRooVisibility: true,
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
    global.fetch = originalFetch;
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
      rolePlay: "Support",
      primaryRolePlay: "Support",
      secondaryRolePlay: "",
      approvedRolePlay: "",
      registrationPool: "main",
      acceptedRules: true,
      acceptedRooVisibility: true,
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

  test("accepts an optional distinct secondary role and rejects invalid secondary role choices", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();

    const created = await store.createPendingTourneyPlayer({
      payload: {
        ...basePayload,
        secondaryRolePlay: "Damage",
      },
      recipients: approvers,
      env,
    });

    expect(created.player).toMatchObject({
      rolePlay: "Support",
      primaryRolePlay: "Support",
      secondaryRolePlay: "Damage",
      approvedRolePlay: "",
    });

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          email: "samerole@example.com",
          discord: "SameRole#1234",
          secondaryRolePlay: "Support",
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("Secondary role must be different from primary role.");

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          email: "badrole@example.com",
          discord: "BadRole#1234",
          secondaryRolePlay: "Lucio",
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("Choose a valid secondary role.");
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

  test("requires display name, password confirmation, timezone, Twitch username, August availability, and agreements", async () => {
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
    ).rejects.toThrow("You must confirm August 15th and 16th availability.");

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          email: "norules@example.com",
          discord: "NoRules#1234",
          acceptedRules: false,
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("You must agree to follow the tournament rules.");

    await expect(
      store.createPendingTourneyPlayer({
        payload: {
          ...basePayload,
          email: "nopromo@example.com",
          discord: "NoPromo#1234",
          acceptedRooVisibility: false,
        },
        recipients: approvers,
        env,
      })
    ).rejects.toThrow("You must acknowledge the event visibility note.");
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
      rolePlay: "Support",
      primaryRolePlay: "Support",
      approvedRolePlay: "Support",
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
      registrationPool: "main",
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

  test("approves a pending player as either submitted role", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();
    const created = await store.createPendingTourneyPlayer({
      payload: {
        ...basePayload,
        secondaryRolePlay: "Damage",
      },
      recipients: approvers,
      env,
    });

    const approved = await store.applyRegistrationDecision({
      tokenHash: "",
      playerId: created.player.id,
      purpose: "approve",
      actorUsername: "serviroo",
      approvedRolePlay: "Damage",
      env,
    });

    expect(approved).toMatchObject({
      status: "approved",
      rolePlay: "Damage",
      primaryRolePlay: "Support",
      secondaryRolePlay: "Damage",
      approvedRolePlay: "Damage",
      registrationPool: "main",
    });

    await expect(store.listApprovedTourneyPlayers({ env })).resolves.toEqual([
      {
        id: approved.id,
        displayName: "Player One",
        rolePlay: "Damage",
        registrationPool: "main",
        teamName: "",
        twitchUsername: "playerone",
      },
    ]);
  });

  test("adds Twitch profile images to public roster players when lookup is enabled", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();
    const imageUrl =
      "https://static-cdn.jtvnw.net/jtv_user_pictures/player-profile_image-300x300.png";
    global.fetch = jest.fn(async () => ({
      ok: true,
      text: async () => `<meta property="og:image" content="${imageUrl}">`,
      json: async () => ({}),
    }));

    const player = await store.createApprovedTourneyPlayer({
      payload: {
        ...basePayload,
        twitchUsername: "PlayerOne",
      },
      actorUsername: "yukari",
      env,
    });

    await expect(
      store.listApprovedTourneyPlayers({
        env: {
          ...env,
          TOURNEY_TWITCH_PROFILE_LOOKUP: "1",
        },
      })
    ).resolves.toEqual([
      {
        id: player.id,
        displayName: "Player One",
        rolePlay: "Support",
        registrationPool: "main",
        teamName: "",
        twitchUsername: "playerone",
        twitchProfileImageUrl: imageUrl,
      },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://www.twitch.tv/playerone",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "text/html" }),
      })
    );
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

  test("tracks Discord invite email and role assignment state for approved players", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();
    const player = await store.createApprovedTourneyPlayer({
      payload: basePayload,
      actorUsername: "serviroo",
      env,
    });

    await expect(
      store.listApprovedTourneyDiscordInviteRecipients({ env })
    ).resolves.toHaveLength(1);

    await expect(
      store.markTourneyDiscordInviteEmailFailed({
        playerId: player.id,
        errorMessage: "resend failed",
        env,
      })
    ).resolves.toMatchObject({
      discordInviteLastError: "resend failed",
    });

    await expect(
      store.markTourneyDiscordInviteEmailSent({
        playerId: player.id,
        emailId: "email_123",
        sentAt: "2026-06-08T00:00:00.000Z",
        env,
      })
    ).resolves.toMatchObject({
      discordInviteSentAt: "2026-06-08T00:00:00.000Z",
      discordInviteEmailId: "email_123",
      discordInviteLastError: "",
    });

    await expect(
      store.listApprovedTourneyDiscordInviteRecipients({ env })
    ).resolves.toHaveLength(0);
    await expect(
      store.listApprovedTourneyDiscordInviteRecipients({
        includeAlreadySent: true,
        env,
      })
    ).resolves.toHaveLength(1);

    await expect(
      store.recordTourneyPlayerDiscordLink({
        playerId: player.id,
        discordUser: {
          id: "1234567890",
          username: "servi",
          global_name: "Serviroo",
        },
        linkedAt: "2026-06-08T00:01:00.000Z",
        env,
      })
    ).resolves.toMatchObject({
      discordUserId: "1234567890",
      discordOauthUsername: "servi",
      discordOauthGlobalName: "Serviroo",
      discordLinkedAt: "2026-06-08T00:01:00.000Z",
    });

    await expect(
      store.markTourneyPlayerDiscordRoleFailed({
        playerId: player.id,
        errorMessage: "missing permissions",
        env,
      })
    ).resolves.toMatchObject({
      discordRoleLastError: "missing permissions",
    });
    await expect(
      store.markTourneyPlayerDiscordRoleAssigned({
        playerId: player.id,
        assignedAt: "2026-06-08T00:02:00.000Z",
        env,
      })
    ).resolves.toMatchObject({
      discordRoleAssignedAt: "2026-06-08T00:02:00.000Z",
      discordRoleLastError: "",
    });
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
          registrationPool: "substitute",
          twitchUsername: "skinz_ow",
        },
        actorUsername: "yukari",
        env,
      })
    ).resolves.toMatchObject({
      displayName: "Skinz",
      teamName: "Team Cyber",
      registrationPool: "substitute",
      twitchUsername: "skinz_ow",
    });

    const publicPlayers = await store.listApprovedTourneyPlayers({ env });
    expect(publicPlayers[0]).toEqual({
      id: player.id,
      displayName: "Skinz",
      rolePlay: "Support",
      registrationPool: "substitute",
      teamName: "Team Cyber",
      twitchUsername: "skinz_ow",
    });
  });

  test("calculates formula role caps from the configured team count", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();

    await expect(store.getTourneyRoleCapacitySnapshot({ env })).resolves.toMatchObject({
      teamCount: 8,
      roles: expect.arrayContaining([
        expect.objectContaining({
          role: "Support",
          cap: 15,
          totalCap: 16,
          mainCount: 0,
          reservedFor: "Frogger",
          reservedCap: 1,
          reservedCount: 0,
          isFull: false,
        }),
      ]),
    });

    await store.updateTourneyRegistrationConfig({
      teamCount: 10,
      actorUsername: "serviroo",
      env,
    });

    await expect(store.getTourneyRoleCapacitySnapshot({ env })).resolves.toMatchObject({
      teamCount: 10,
      roles: expect.arrayContaining([
        expect.objectContaining({
          role: "Support",
          cap: 19,
          totalCap: 20,
          reservedFor: "Frogger",
          reservedCap: 1,
        }),
      ]),
    });
  });

  test("uses only approved main-pool players for role caps and confirmed substitute overflow", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();
    await store.updateTourneyRegistrationConfig({
      teamCount: 2,
      actorUsername: "serviroo",
      env,
    });

    const payloadFor = (index) => ({
      ...basePayload,
      email: `support${index}@example.com`,
      discord: `Support${index}#1234`,
      displayName: `Support ${index}`,
      twitchUsername: `support${index}`,
    });

    for (let index = 1; index <= 4; index += 1) {
      await store.createPendingTourneyPlayer({
        payload: payloadFor(index),
        recipients: approvers,
        env,
      });
    }

    await expect(store.getTourneyRoleCapacitySnapshot({ env })).resolves.toMatchObject({
      teamCount: 2,
      roles: expect.arrayContaining([
        expect.objectContaining({
          role: "Support",
          cap: 3,
          totalCap: 4,
          mainCount: 0,
          pendingMainCount: 0,
          approvedMainCount: 0,
          isFull: false,
        }),
      ]),
    });

    await store.createPendingTourneyPlayer({
      payload: payloadFor(5),
      recipients: approvers,
      env,
    });

    for (let index = 6; index <= 8; index += 1) {
      await store.createApprovedTourneyPlayer({
        payload: payloadFor(index),
        actorUsername: "serviroo",
        env,
      });
    }

    const overflowPending = await store.createPendingTourneyPlayer({
      payload: payloadFor(10),
      recipients: approvers,
      env,
    });

    expect(overflowPending.player).toMatchObject({
      rolePlay: "Support",
      registrationPool: "main",
    });

    const substitute = await store.applyRegistrationDecision({
      tokenHash: "",
      playerId: overflowPending.player.id,
      purpose: "approve",
      actorUsername: "serviroo",
      env,
    });

    expect(substitute).toMatchObject({
      rolePlay: "Support",
      approvedRolePlay: "Support",
      registrationPool: "substitute",
    });
    await expect(store.getTourneyRoleCapacitySnapshot({ env })).resolves.toMatchObject({
      roles: expect.arrayContaining([
        expect.objectContaining({
          role: "Support",
          cap: 3,
          totalCap: 4,
          mainCount: 3,
          pendingMainCount: 0,
          approvedMainCount: 3,
          substituteCount: 1,
          isFull: true,
        }),
      ]),
    });
  });

  test("excludes denied and removed players from role-cap counts", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();
    await store.updateTourneyRegistrationConfig({
      teamCount: 2,
      actorUsername: "serviroo",
      env,
    });

    const payloadFor = (index) => ({
      ...basePayload,
      email: `cap${index}@example.com`,
      discord: `Cap${index}#1234`,
      displayName: `Cap ${index}`,
      twitchUsername: `cap${index}`,
    });

    const pendingOne = await store.createPendingTourneyPlayer({
      payload: payloadFor(1),
      recipients: approvers,
      env,
    });
    const deniedCandidate = await store.createPendingTourneyPlayer({
      payload: payloadFor(2),
      recipients: approvers,
      env,
    });
    const approvedOne = await store.createApprovedTourneyPlayer({
      payload: payloadFor(3),
      actorUsername: "serviroo",
      env,
    });
    const removedCandidate = await store.createApprovedTourneyPlayer({
      payload: payloadFor(4),
      actorUsername: "serviroo",
      env,
    });

    await expect(store.getTourneyRoleCapacitySnapshot({ env })).resolves.toMatchObject({
      roles: expect.arrayContaining([
        expect.objectContaining({
          role: "Support",
          cap: 3,
          totalCap: 4,
          mainCount: 2,
          pendingMainCount: 0,
          approvedMainCount: 2,
          isFull: false,
        }),
      ]),
    });

    await store.applyRegistrationDecision({
      tokenHash: "",
      playerId: deniedCandidate.player.id,
      purpose: "deny",
      actorUsername: "serviroo",
      env,
    });
    await store.kickTourneyPlayer({
      playerId: removedCandidate.id,
      actorUsername: "serviroo",
      env,
    });

    await expect(store.getTourneyRoleCapacitySnapshot({ env })).resolves.toMatchObject({
      roles: expect.arrayContaining([
        expect.objectContaining({
          role: "Support",
          cap: 3,
          totalCap: 4,
          mainCount: 1,
          pendingMainCount: 0,
          approvedMainCount: 1,
          isFull: false,
        }),
      ]),
    });

    expect(pendingOne.player.registrationPool).toBe("main");
    expect(approvedOne.registrationPool).toBe("main");
    for (let index = 5; index <= 6; index += 1) {
      await store.createApprovedTourneyPlayer({
        payload: payloadFor(index),
        actorUsername: "serviroo",
        env,
      });
    }
    await expect(store.getTourneyRoleCapacitySnapshot({ env })).resolves.toMatchObject({
      roles: expect.arrayContaining([
        expect.objectContaining({
          role: "Support",
          cap: 3,
          totalCap: 4,
          mainCount: 3,
          pendingMainCount: 0,
          approvedMainCount: 3,
          isFull: true,
        }),
      ]),
    });
    await expect(
      store.createPendingTourneyPlayer({
        payload: payloadFor(8),
        recipients: approvers,
        env,
      })
    ).resolves.toMatchObject({
      player: {
        rolePlay: "Support",
        registrationPool: "main",
        status: "pending",
      },
    });
  });

  test("moves a pending main-pool player to substitute when approval would exceed the role cap", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();
    await store.updateTourneyRegistrationConfig({
      teamCount: 2,
      actorUsername: "serviroo",
      env,
    });

    const payloadFor = (index) => ({
      ...basePayload,
      email: `overflow${index}@example.com`,
      discord: `Overflow${index}#1234`,
      displayName: `Overflow ${index}`,
      twitchUsername: `overflow${index}`,
    });

    const pending = await store.createPendingTourneyPlayer({
      payload: payloadFor(1),
      recipients: approvers,
      env,
    });

    for (let index = 2; index <= 4; index += 1) {
      await store.createApprovedTourneyPlayer({
        payload: payloadFor(index),
        actorUsername: "serviroo",
        env,
      });
    }

    const approved = await store.applyRegistrationDecision({
      tokenHash: "",
      playerId: pending.player.id,
      purpose: "approve",
      actorUsername: "serviroo",
      env,
    });

    expect(approved).toMatchObject({
      status: "approved",
      registrationPool: "substitute",
    });
    await expect(store.getTourneyRoleCapacitySnapshot({ env })).resolves.toMatchObject({
      roles: expect.arrayContaining([
        expect.objectContaining({
          role: "Support",
          cap: 3,
          totalCap: 4,
          mainCount: 3,
          substituteCount: 1,
          approvedMainCount: 3,
          isFull: true,
        }),
      ]),
    });
  });

  test("reserves the final Support main-pool slot for Frogger", async () => {
    const store = loadStore();
    store.resetMemoryTourneyPlayerStoreForTests();
    await store.updateTourneyRegistrationConfig({
      teamCount: 2,
      actorUsername: "serviroo",
      env,
    });

    const payloadFor = (index) => ({
      ...basePayload,
      email: `reserved${index}@example.com`,
      discord: `Reserved${index}#1234`,
      displayName: `Reserved ${index}`,
      twitchUsername: `reserved${index}`,
    });

    for (let index = 1; index <= 3; index += 1) {
      await store.createApprovedTourneyPlayer({
        payload: payloadFor(index),
        actorUsername: "serviroo",
        env,
      });
    }

    const overflowPending = await store.createPendingTourneyPlayer({
      payload: payloadFor(4),
      recipients: approvers,
      env,
    });
    await expect(
      store.applyRegistrationDecision({
        tokenHash: "",
        playerId: overflowPending.player.id,
        purpose: "approve",
        actorUsername: "serviroo",
        env,
      })
    ).resolves.toMatchObject({
      rolePlay: "Support",
      registrationPool: "substitute",
    });

    const frogger = await store.createPendingTourneyPlayer({
      payload: {
        ...basePayload,
        email: "frogger@example.com",
        discord: "Frogger#1234",
        displayName: "Frogger",
        twitchUsername: "FroggerOW",
      },
      recipients: approvers,
      env,
    });

    expect(frogger.player).toMatchObject({
      displayName: "Frogger",
      twitchUsername: "froggerow",
      rolePlay: "Support",
      registrationPool: "main",
    });

    await store.applyRegistrationDecision({
      tokenHash: "",
      playerId: frogger.player.id,
      purpose: "approve",
      actorUsername: "serviroo",
      env,
    });

    await expect(store.getTourneyRoleCapacitySnapshot({ env })).resolves.toMatchObject({
      roles: expect.arrayContaining([
        expect.objectContaining({
          role: "Support",
          cap: 3,
          totalCap: 4,
          mainCount: 3,
          reservedFor: "Frogger",
          reservedCap: 1,
          reservedCount: 1,
          totalMainCount: 4,
          isFull: true,
          reservedIsFull: true,
        }),
      ]),
    });
  });
});
