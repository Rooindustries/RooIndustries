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

const { GET } = require("../../app/api/tourney/registration-decision/route.js");

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

const makeRequest = ({ cookie = "" } = {}) => ({
  url: "https://www.rooindustries.com/api/tourney/registration-decision?token=abc123&decision=approve",
  cookies: {
    get: (name) =>
      name === "tourney_session" && cookie ? { value: cookie } : undefined,
  },
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
    });
    expect(mockSendTourneyPlayerApprovedEmail).toHaveBeenCalledWith({
      player: approvedPlayer,
      baseUrl: "https://www.rooindustries.com",
    });
    expect(html).toContain("Approved");
    expect(html).toContain("approval email was sent");
  });
});
