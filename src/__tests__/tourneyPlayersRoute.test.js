const mockCheckTourneyRateLimit = jest.fn();
const mockGetClientAddressFromHeaders = jest.fn();
const mockReadTourneySessionFromStore = jest.fn();
const mockApplyRegistrationDecision = jest.fn();
const mockCreateApprovedTourneyPlayer = jest.fn();
const mockGetTourneyRoleCapacitySnapshot = jest.fn();
const mockKickTourneyPlayer = jest.fn();
const mockListManageTourneyPlayers = jest.fn();
const mockUpdateTourneyPlayerApprovedRole = jest.fn();
const mockUpdateTourneyRegistrationConfig = jest.fn();
const mockUpdateTourneyPlayerDetails = jest.fn();
const mockEnqueueTourneyEmailDispatch = jest.fn();
const mockWithdrawTourneyPlayer = jest.fn();
const originalResponseJson = Response.json;

if (!Response.json) {
  Response.json = (body, init = {}) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
}

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status || 200,
      json: async () => body,
      headers: init.headers || {},
    }),
  },
}));

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  checkTourneyRateLimit: (...args) => mockCheckTourneyRateLimit(...args),
  getClientAddressFromHeaders: (...args) => mockGetClientAddressFromHeaders(...args),
  readTourneySessionFromStore: (...args) =>
    mockReadTourneySessionFromStore(...args),
}));

jest.mock("../server/tourney/emailDispatch", () => ({
  enqueueTourneyEmailDispatch: (...args) =>
    mockEnqueueTourneyEmailDispatch(...args),
}));

jest.mock("../server/tourney/playerStore", () => ({
  applyRegistrationDecision: (...args) => mockApplyRegistrationDecision(...args),
  createApprovedTourneyPlayer: (...args) => mockCreateApprovedTourneyPlayer(...args),
  getTourneyRoleCapacitySnapshot: (...args) =>
    mockGetTourneyRoleCapacitySnapshot(...args),
  kickTourneyPlayer: (...args) => mockKickTourneyPlayer(...args),
  listManageTourneyPlayers: (...args) => mockListManageTourneyPlayers(...args),
  updateTourneyPlayerApprovedRole: (...args) =>
    mockUpdateTourneyPlayerApprovedRole(...args),
  updateTourneyRegistrationConfig: (...args) =>
    mockUpdateTourneyRegistrationConfig(...args),
  updateTourneyPlayerDetails: (...args) => mockUpdateTourneyPlayerDetails(...args),
  withdrawTourneyPlayer: (...args) => mockWithdrawTourneyPlayer(...args),
}));

const { POST } = require("../../app/api/tourney/players/route.js");

const makeJsonRequest = (payload, cookie = "caster-session", contentLength = "") => ({
  url: "https://www.rooindustries.com/api/tourney/players",
  headers: {
    get: (name) => {
      const key = String(name || "").toLowerCase();
      if (key === "content-type") return "application/json";
      if (key === "content-length") return contentLength;
      return "";
    },
  },
  cookies: {
    get: (name) =>
      name === "tourney_session" && cookie ? { value: cookie } : undefined,
  },
  text: async () => JSON.stringify(payload),
});

describe("tourney players API route", () => {
  afterAll(() => {
    if (originalResponseJson) {
      Response.json = originalResponseJson;
    } else {
      delete Response.json;
    }
  });

  beforeEach(() => {
    mockCheckTourneyRateLimit.mockReset();
    mockGetClientAddressFromHeaders.mockReset();
    mockReadTourneySessionFromStore.mockReset();
    mockApplyRegistrationDecision.mockReset();
    mockCreateApprovedTourneyPlayer.mockReset();
    mockGetTourneyRoleCapacitySnapshot.mockReset();
    mockKickTourneyPlayer.mockReset();
    mockListManageTourneyPlayers.mockReset();
    mockUpdateTourneyPlayerApprovedRole.mockReset();
    mockUpdateTourneyRegistrationConfig.mockReset();
    mockUpdateTourneyPlayerDetails.mockReset();
    mockEnqueueTourneyEmailDispatch.mockReset();
    mockWithdrawTourneyPlayer.mockReset();

    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockGetClientAddressFromHeaders.mockReturnValue("127.0.0.1");
    mockCheckTourneyRateLimit.mockReturnValue({ ok: true });
    mockListManageTourneyPlayers.mockResolvedValue([]);
    mockGetTourneyRoleCapacitySnapshot.mockResolvedValue({
      teamCount: 8,
      roles: [],
    });
    mockEnqueueTourneyEmailDispatch.mockResolvedValue({ id: "dispatch_1" });
  });

  test("emails the player when a pending registration is approved from Manage", async () => {
    const approvedPlayer = {
      id: "player_1",
      email: "playerone@example.com",
      discord: "PlayerOne#1234",
    };
    mockApplyRegistrationDecision.mockResolvedValue(approvedPlayer);

    const response = await POST(
      makeJsonRequest({
        action: "approve",
        playerId: "player_1",
        approvedRolePlay: "Support",
      })
    );

    expect(response.status).toBe(200);
    expect(mockApplyRegistrationDecision).toHaveBeenCalledWith({
      tokenHash: "",
      playerId: "player_1",
      purpose: "approve",
      actorUsername: "yukari",
      approvedRolePlay: "Support",
    });
    expect(mockEnqueueTourneyEmailDispatch).toHaveBeenCalledWith({
      commandId: expect.any(String),
      dispatchKind: "approval",
      recipient: "playerone@example.com",
      payload: {
      player: approvedPlayer,
      baseUrl: "https://www.rooindustries.com",
      },
    });
  });

  test("does not queue another approval email for an already-completed decision", async () => {
    mockApplyRegistrationDecision.mockResolvedValue({
      id: "player_1",
      email: "playerone@example.com",
      discord: "PlayerOne#1234",
      decisionTransitioned: false,
    });

    const response = await POST(makeJsonRequest({
      action: "approve",
      playerId: "player_1",
      approvedRolePlay: "Support",
    }));

    expect(response.status).toBe(200);
    expect(mockEnqueueTourneyEmailDispatch).not.toHaveBeenCalled();
  });

  test("rejects an oversized player mutation", async () => {
    const response = await POST(makeJsonRequest({ action: "approve" }, "caster-session", "32769"));
    expect(response.status).toBe(413);
    expect(mockApplyRegistrationDecision).not.toHaveBeenCalled();
  });

  test("allows admins and casters to update public player details", async () => {
    mockUpdateTourneyPlayerDetails.mockResolvedValue({
      id: "player_1",
      displayName: "Skinz",
      teamName: "Team Cyber",
      registrationPool: "substitute",
      twitchUsername: "skinz_ow",
    });
    mockListManageTourneyPlayers.mockResolvedValue([
      {
        id: "player_1",
        displayName: "Skinz",
        teamName: "Team Cyber",
        registrationPool: "substitute",
        twitchUsername: "skinz_ow",
      },
    ]);

    const response = await POST(
      makeJsonRequest({
        action: "update-details",
        playerId: "player_1",
        displayName: "Skinz",
        teamName: "Team Cyber",
        registrationPool: "substitute",
        twitchUsername: "skinz_ow",
      })
    );

    expect(response.status).toBe(200);
    expect(mockListManageTourneyPlayers).toHaveBeenCalled();
    expect(mockUpdateTourneyPlayerDetails).toHaveBeenCalledWith({
      playerId: "player_1",
      payload: {
        action: "update-details",
        playerId: "player_1",
        displayName: "Skinz",
        teamName: "Team Cyber",
        registrationPool: "substitute",
        twitchUsername: "skinz_ow",
      },
      actorUsername: "yukari",
    });
  });

  test("allows admins and casters to correct an approved player role", async () => {
    mockUpdateTourneyPlayerApprovedRole.mockResolvedValue({
      id: "player_1",
      rolePlay: "Flex",
      approvedRolePlay: "Flex",
    });
    mockListManageTourneyPlayers.mockResolvedValue([
      {
        id: "player_1",
        rolePlay: "Flex",
        approvedRolePlay: "Flex",
      },
    ]);

    const response = await POST(
      makeJsonRequest({
        action: "update-role",
        playerId: "player_1",
        rolePlay: "Flex",
      })
    );

    expect(response.status).toBe(200);
    expect(mockListManageTourneyPlayers).toHaveBeenCalled();
    expect(mockUpdateTourneyPlayerApprovedRole).toHaveBeenCalledWith({
      playerId: "player_1",
      rolePlay: "Flex",
      actorUsername: "yukari",
    });
  });

  test("allows admins and casters to mark an approved player as opted out", async () => {
    mockWithdrawTourneyPlayer.mockResolvedValue({
      id: "player_1",
      status: "withdrawn",
      withdrawnBy: "yukari",
    });
    mockListManageTourneyPlayers.mockResolvedValue([
      {
        id: "player_1",
        status: "withdrawn",
        withdrawnBy: "yukari",
      },
    ]);

    const response = await POST(
      makeJsonRequest({
        action: "withdraw",
        playerId: "player_1",
      })
    );

    expect(response.status).toBe(200);
    expect(mockListManageTourneyPlayers).toHaveBeenCalled();
    expect(mockWithdrawTourneyPlayer).toHaveBeenCalledWith({
      playerId: "player_1",
      actorUsername: "yukari",
    });
  });

  test("allows admins and casters to update registration capacity", async () => {
    mockGetTourneyRoleCapacitySnapshot.mockResolvedValue({
      teamCount: 10,
      roles: [{ role: "Support", cap: 20, mainCount: 16 }],
    });

    const response = await POST(
      makeJsonRequest({
        action: "update-capacity",
        teamCount: 10,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockUpdateTourneyRegistrationConfig).toHaveBeenCalledWith({
      teamCount: 10,
      actorUsername: "yukari",
    });
    expect(body.capacity).toMatchObject({
      teamCount: 10,
      roles: [{ role: "Support", cap: 20, mainCount: 16 }],
    });
  });

  test("blocks non-admin users from updating player details", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "player-one",
      role: "player",
    });

    const response = await POST(
      makeJsonRequest({
        action: "update-details",
        playerId: "player_1",
        displayName: "Skinz",
        teamName: "Team Cyber",
        twitchUsername: "skinz_ow",
      })
    );

    expect(response.status).toBe(404);
    expect(mockUpdateTourneyPlayerDetails).not.toHaveBeenCalled();
  });

  test("blocks non-admin users from updating registration capacity", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "player-one",
      role: "player",
    });

    const response = await POST(
      makeJsonRequest({
        action: "update-capacity",
        teamCount: 10,
      })
    );

    expect(response.status).toBe(404);
    expect(mockUpdateTourneyRegistrationConfig).not.toHaveBeenCalled();
  });
});
