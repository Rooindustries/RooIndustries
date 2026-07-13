const mockCheckTourneyRateLimit = jest.fn();
const mockGetClientAddressFromHeaders = jest.fn();
const mockReadTourneySessionFromStore = jest.fn();
const mockCreateTourneyAppeal = jest.fn();
const mockListTourneyAppealsForSession = jest.fn();
const mockUpdateTourneyAppeal = jest.fn();
const mockListTourneyPayoutsForSession = jest.fn();
const mockUpsertTourneyPayout = jest.fn();
const mockGetTourneyApprovalRecipients = jest.fn();
const mockGetApprovedTourneyPlayerById = jest.fn();
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
  getTourneyApprovalRecipients: (...args) => mockGetTourneyApprovalRecipients(...args),
  readTourneySessionFromStore: (...args) =>
    mockReadTourneySessionFromStore(...args),
}));

jest.mock("../server/tourney/playerStore", () => ({
  getApprovedTourneyPlayerById: (...args) => mockGetApprovedTourneyPlayerById(...args),
}));

jest.mock("../server/tourney/appealPayoutStore", () => ({
  createTourneyAppeal: (...args) => mockCreateTourneyAppeal(...args),
  listTourneyAppealsForSession: (...args) =>
    mockListTourneyAppealsForSession(...args),
  updateTourneyAppeal: (...args) => mockUpdateTourneyAppeal(...args),
  listTourneyPayoutsForSession: (...args) => mockListTourneyPayoutsForSession(...args),
  upsertTourneyPayout: (...args) => mockUpsertTourneyPayout(...args),
}));

const appealsRoute = require("../../app/api/tourney/appeals/route.js");
const payoutsRoute = require("../../app/api/tourney/payouts/route.js");

const makeJsonRequest = (payload = {}, cookie = "player-session") => ({
  url: "https://www.rooindustries.com/api/tourney/hidden",
  headers: {
    get: (name) =>
      String(name || "").toLowerCase() === "content-type"
        ? "application/json"
        : "",
  },
  cookies: {
    get: (name) =>
      name === "tourney_session" && cookie ? { value: cookie } : undefined,
  },
  json: async () => payload,
});

describe("hidden tourney appeals and payouts routes", () => {
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
    mockCreateTourneyAppeal.mockReset();
    mockListTourneyAppealsForSession.mockReset();
    mockUpdateTourneyAppeal.mockReset();
    mockListTourneyPayoutsForSession.mockReset();
    mockUpsertTourneyPayout.mockReset();
    mockGetTourneyApprovalRecipients.mockReset();
    mockGetApprovedTourneyPlayerById.mockReset();

    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "player-one",
      role: "player",
    });
    mockGetClientAddressFromHeaders.mockReturnValue("127.0.0.1");
    mockCheckTourneyRateLimit.mockReturnValue({ ok: true });
    mockListTourneyAppealsForSession.mockResolvedValue([]);
    mockListTourneyPayoutsForSession.mockResolvedValue([]);
    mockGetTourneyApprovalRecipients.mockResolvedValue([]);
    mockGetApprovedTourneyPlayerById.mockResolvedValue(null);
  });

  test("hides appeals and payouts from logged-out users", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue(null);

    const appeals = await appealsRoute.GET(makeJsonRequest({}, ""));
    const payouts = await payoutsRoute.GET(makeJsonRequest({}, ""));

    expect(appeals.status).toBe(404);
    expect(payouts.status).toBe(404);
  });

  test("allows players to submit appeals", async () => {
    const payload = {
      action: "create",
      appealType: "team-appeal",
      title: "Score dispute",
      details: "Captain appeal details",
    };

    const response = await appealsRoute.POST(makeJsonRequest(payload));

    expect(response.status).toBe(200);
    expect(mockCreateTourneyAppeal).toHaveBeenCalledWith({
      payload,
      session: { username: "player-one", role: "player" },
    });
    expect(mockListTourneyAppealsForSession).toHaveBeenCalledWith({
      session: { username: "player-one", role: "player" },
    });
  });

  test("blocks players from updating appeals", async () => {
    const response = await appealsRoute.POST(
      makeJsonRequest({
        action: "update",
        appealId: "appeal_1",
        status: "upheld",
      })
    );

    expect(response.status).toBe(404);
    expect(mockUpdateTourneyAppeal).not.toHaveBeenCalled();
  });

  test("allows casters to update appeals", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    const payload = {
      action: "update",
      appealId: "appeal_1",
      status: "upheld",
      ruling: "Accepted",
    };

    const response = await appealsRoute.POST(makeJsonRequest(payload, "caster-session"));

    expect(response.status).toBe(200);
    expect(mockUpdateTourneyAppeal).toHaveBeenCalledWith({
      appealId: "appeal_1",
      payload,
      session: { username: "yukari", role: "caster" },
    });
  });

  test("blocks players from writing payouts", async () => {
    const response = await payoutsRoute.POST(
      makeJsonRequest({
        playerId: "player_1",
        payoutType: "mvp",
        amountUsd: "25",
      })
    );

    expect(response.status).toBe(404);
    expect(mockUpsertTourneyPayout).not.toHaveBeenCalled();
  });

  test("allows casters to write payouts", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "supa",
      role: "caster",
    });
    const payload = {
      playerId: "player_1",
      payoutType: "mvp",
      amountUsd: "25",
      status: "ready",
    };

    const response = await payoutsRoute.POST(makeJsonRequest(payload, "caster-session"));

    expect(response.status).toBe(200);
    expect(mockUpsertTourneyPayout).toHaveBeenCalledWith({
      payload,
      session: { username: "supa", role: "caster" },
    });
    expect(mockListTourneyPayoutsForSession).toHaveBeenCalledWith({
      session: { username: "supa", role: "caster" },
    });
  });
});
