const mockCheckTourneyRateLimit = jest.fn();
const mockGetClientAddressFromHeaders = jest.fn();
const mockGetTourneyApprovalRecipients = jest.fn();
const mockCreatePendingTourneyPlayer = jest.fn();
const mockCreateTourneyPasswordHash = jest.fn();
const mockGetTourneyRegistrationCloseIso = jest.fn();
const mockIsTourneyRegistrationClosed = jest.fn();
const mockSendTourneyRegistrationApprovalEmails = jest.fn();
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
  checkTourneyRateLimit: (...args) => mockCheckTourneyRateLimit(...args),
  getClientAddressFromHeaders: (...args) => mockGetClientAddressFromHeaders(...args),
  getTourneyApprovalRecipients: (...args) =>
    mockGetTourneyApprovalRecipients(...args),
}));

jest.mock("../server/tourney/email", () => ({
  sendTourneyRegistrationApprovalEmails: (...args) =>
    mockSendTourneyRegistrationApprovalEmails(...args),
}));

jest.mock("../server/tourney/playerStore", () => ({
  createPendingTourneyPlayer: (...args) => mockCreatePendingTourneyPlayer(...args),
  createTourneyPasswordHash: (...args) => mockCreateTourneyPasswordHash(...args),
  getTourneyRegistrationCloseIso: (...args) =>
    mockGetTourneyRegistrationCloseIso(...args),
  isTourneyRegistrationClosed: (...args) => mockIsTourneyRegistrationClosed(...args),
}));

const { POST } = require("../../app/api/tourney/register/route.js");

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
  acceptedCreatorEligibility: true,
  acceptedRooVisibility: true,
  notes: "",
};

const makeJsonRequest = (payload) => {
  const body = JSON.stringify(payload);
  return {
    url: "https://www.rooindustries.com/api/tourney/register",
    headers: {
      get: (name) => {
        const normalized = String(name || "").toLowerCase();
        if (normalized === "content-type") return "application/json";
        if (normalized === "content-length") return String(Buffer.byteLength(body));
        return "";
      },
    },
    text: async () => body,
  };
};

describe("tourney register API route", () => {
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
    mockGetTourneyApprovalRecipients.mockReset();
    mockCreatePendingTourneyPlayer.mockReset();
    mockCreateTourneyPasswordHash.mockReset();
    mockGetTourneyRegistrationCloseIso.mockReset();
    mockIsTourneyRegistrationClosed.mockReset();
    mockSendTourneyRegistrationApprovalEmails.mockReset();

    mockIsTourneyRegistrationClosed.mockReturnValue(false);
    mockGetTourneyRegistrationCloseIso.mockReturnValue("2026-07-22T00:00:00.000Z");
    mockGetClientAddressFromHeaders.mockReturnValue("127.0.0.1");
    mockCheckTourneyRateLimit.mockReturnValue({ ok: true });
    mockGetTourneyApprovalRecipients.mockResolvedValue([
      {
        username: "serviroo",
        email: "serviroo@rooindustries.com",
        role: "owner",
        version: "1",
      },
    ]);
    mockCreatePendingTourneyPlayer.mockResolvedValue({
      player: { id: "player_1", email: "playerone@example.com" },
      tokens: [],
    });
    mockCreateTourneyPasswordHash.mockResolvedValue("prepared-password-hash");
    mockSendTourneyRegistrationApprovalEmails.mockResolvedValue({ id: "email_1" });
  });

  test("passes substitute-pool confirmation through to player creation", async () => {
    const response = await POST(
      makeJsonRequest({ ...basePayload, acceptSubstitutePool: true })
    );

    expect(response.status).toBe(200);
    expect(mockCreatePendingTourneyPlayer).toHaveBeenCalledWith({
      payload: { ...basePayload, acceptSubstitutePool: true },
      recipients: expect.any(Array),
      authUserId: "",
      preparedPasswordHash: "prepared-password-hash",
    });
  });

  test("passes creator eligibility acknowledgement through from form submissions", async () => {
    const formValues = new Map(
      Object.entries({
        ...basePayload,
        acceptedCreatorEligibility: "on",
      })
    );
    const request = {
      url: "https://www.rooindustries.com/api/tourney/register",
      headers: { get: () => "" },
      formData: async () => ({
        get: (key) => formValues.get(key) || null,
      }),
    };

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockCreatePendingTourneyPlayer).toHaveBeenCalledWith({
      payload: expect.objectContaining({
        acceptedCreatorEligibility: "on",
      }),
      recipients: expect.any(Array),
      authUserId: "",
      preparedPasswordHash: "prepared-password-hash",
    });
  });

  test("blocks registrations after the configured close time", async () => {
    mockIsTourneyRegistrationClosed.mockReturnValue(true);

    const response = await POST(makeJsonRequest(basePayload));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      ok: false,
      code: "REGISTRATION_CLOSED",
      error: "Registration is closed.",
      registrationClosesAt: "2026-07-22T00:00:00.000Z",
    });
    expect(mockGetTourneyApprovalRecipients).not.toHaveBeenCalled();
    expect(mockCreatePendingTourneyPlayer).not.toHaveBeenCalled();
  });

  test("returns structured role-capacity conflicts", async () => {
    const capacity = {
      role: "Support",
      cap: 16,
      mainCount: 16,
      substituteCount: 0,
      isFull: true,
    };
    mockCreatePendingTourneyPlayer.mockRejectedValue(
      Object.assign(
        new Error("This role is at maximum capacity for the main bracket."),
        {
          status: 409,
          code: "ROLE_CAPACITY_FULL",
          capacity,
          capacitySnapshot: { teamCount: 8, roles: [capacity] },
        }
      )
    );

    const response = await POST(makeJsonRequest(basePayload));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      code: "ROLE_CAPACITY_FULL",
      error: "This role is at maximum capacity for the main bracket.",
      capacity,
      capacitySnapshot: { teamCount: 8, roles: [capacity] },
    });
  });
});
