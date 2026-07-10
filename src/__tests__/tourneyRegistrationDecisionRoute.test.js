const mockFindActiveTourneyApprover = jest.fn();
const mockReadTourneySessionFromStore = jest.fn();
const mockApplyRegistrationDecision = jest.fn();
const mockGetRegistrationDecisionToken = jest.fn();
const mockHashTourneyToken = jest.fn((token) => `hashed:${token}`);
const mockSendTourneyPlayerApprovedEmail = jest.fn();

jest.mock("../server/tourney/auth", () => ({
  TOURNEY_SESSION_COOKIE: "tourney_session",
  findActiveTourneyApprover: (...args) => mockFindActiveTourneyApprover(...args),
  readTourneySessionFromStore: (...args) =>
    mockReadTourneySessionFromStore(...args),
}));

jest.mock("../server/tourney/playerStore", () => ({
  applyRegistrationDecision: (...args) => mockApplyRegistrationDecision(...args),
  getRegistrationDecisionToken: (...args) =>
    mockGetRegistrationDecisionToken(...args),
  hashTourneyToken: (...args) => mockHashTourneyToken(...args),
}));

jest.mock("../server/tourney/email", () => ({
  sendTourneyPlayerApprovedEmail: (...args) =>
    mockSendTourneyPlayerApprovedEmail(...args),
}));

const { GET, POST } = require("../../app/api/tourney/registration-decision/route.js");

const tokenRow = {
  player_id: "player_1",
  recipient_username: "yukari",
  recipient_email: "yukariipoi@gmail.com",
  recipient_role: "caster",
  recipient_version: "1",
};

const approver = {
  username: "yukari",
  role: "caster",
  version: "1",
};

const makeRequest = ({ cookie = "", role = "" } = {}) => ({
  url: `https://www.rooindustries.com/api/tourney/registration-decision?token=abc123&decision=approve${
    role ? `&role=${encodeURIComponent(role)}` : ""
  }`,
  cookies: {
    get: (name) =>
      name === "tourney_session" && cookie ? { value: cookie } : undefined,
  },
});

const makePostRequest = ({ cookie = "", payload = {} } = {}) => ({
  url: "https://www.rooindustries.com/api/tourney/registration-decision",
  headers: {
    get: (name) =>
      String(name || "").toLowerCase() === "origin"
        ? "https://www.rooindustries.com"
        : "",
  },
  cookies: {
    get: (name) =>
      name === "tourney_session" && cookie ? { value: cookie } : undefined,
  },
  json: async () => payload,
});

describe("tourney registration decision route", () => {
  beforeEach(() => {
    mockFindActiveTourneyApprover.mockReset();
    mockReadTourneySessionFromStore.mockReset();
    mockApplyRegistrationDecision.mockReset();
    mockGetRegistrationDecisionToken.mockReset();
    mockHashTourneyToken.mockClear();
    mockHashTourneyToken.mockImplementation((token) => `hashed:${token}`);
    mockSendTourneyPlayerApprovedEmail.mockReset();

    mockGetRegistrationDecisionToken.mockResolvedValue(tokenRow);
    mockFindActiveTourneyApprover.mockResolvedValue(approver);
    mockSendTourneyPlayerApprovedEmail.mockResolvedValue({ id: "email_1" });
  });

  test("does not approve from a valid token without a matching login session", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue(null);

    const response = await GET(makeRequest());
    const html = await response.text();

    expect(html).toContain("Sign in required");
    expect(mockReadTourneySessionFromStore).toHaveBeenCalledWith({ token: "" });
    expect(mockApplyRegistrationDecision).not.toHaveBeenCalled();
    expect(mockSendTourneyPlayerApprovedEmail).not.toHaveBeenCalled();
  });

  test("does not approve from the wrong admin account", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "serviroo",
      role: "owner",
    });

    const response = await GET(makeRequest({ cookie: "owner-session" }));
    const html = await response.text();

    expect(html).toContain("Wrong account");
    expect(mockApplyRegistrationDecision).not.toHaveBeenCalled();
    expect(mockSendTourneyPlayerApprovedEmail).not.toHaveBeenCalled();
  });

  test("does not call invalid decision tokens expired", async () => {
    mockGetRegistrationDecisionToken.mockResolvedValue(null);

    const response = await GET(makeRequest());
    const html = await response.text();

    expect(html).toContain("Link unavailable");
    expect(html).not.toContain("Link expired");
    expect(html).not.toContain("expired, or revoked");
    expect(mockApplyRegistrationDecision).not.toHaveBeenCalled();
    expect(mockSendTourneyPlayerApprovedEmail).not.toHaveBeenCalled();
  });

  test("approves and emails the player from the assigned approver session", async () => {
    const approvedPlayer = {
      id: "player_1",
      email: "playerone@example.com",
      discord: "PlayerOne#1234",
    };
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockApplyRegistrationDecision.mockResolvedValue(approvedPlayer);

    const response = await GET(makeRequest({ cookie: "caster-session" }));
    const html = await response.text();

    expect(mockApplyRegistrationDecision).toHaveBeenCalledWith({
      tokenHash: "hashed:abc123",
      playerId: "player_1",
      purpose: "approve",
      actorUsername: "yukari",
      approvedRolePlay: "",
    });
    expect(mockSendTourneyPlayerApprovedEmail).toHaveBeenCalledWith({
      player: approvedPlayer,
      baseUrl: "https://www.rooindustries.com",
    });
    expect(html).toContain("Approved");
    expect(html).toContain("approval email was sent");
  });

  test("passes the selected approval role from role-specific accept links", async () => {
    const approvedPlayer = {
      id: "player_1",
      email: "playerone@example.com",
      discord: "PlayerOne#1234",
      approvedRolePlay: "Damage",
    };
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockApplyRegistrationDecision.mockResolvedValue(approvedPlayer);

    const response = await GET(
      makeRequest({ cookie: "caster-session", role: "Damage" })
    );
    const html = await response.text();

    expect(mockApplyRegistrationDecision).toHaveBeenCalledWith({
      tokenHash: "hashed:abc123",
      playerId: "player_1",
      purpose: "approve",
      actorUsername: "yukari",
      approvedRolePlay: "Damage",
    });
    expect(mockSendTourneyPlayerApprovedEmail).toHaveBeenCalledWith({
      player: approvedPlayer,
      baseUrl: "https://www.rooindustries.com",
    });
    expect(html).toContain("Approved");
  });

  test("accepts decision credentials in a same-origin POST body", async () => {
    const approvedPlayer = {
      id: "player_1",
      email: "playerone@example.com",
      discord: "PlayerOne#1234",
    };
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockApplyRegistrationDecision.mockResolvedValue(approvedPlayer);

    const response = await POST(
      makePostRequest({
        cookie: "caster-session",
        payload: { token: "abc123", decision: "approve", role: "Support" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, title: "Approved" });
    expect(mockApplyRegistrationDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: "hashed:abc123",
        approvedRolePlay: "Support",
      })
    );
  });
});
