const mockCheckTourneyRateLimit = jest.fn();
const mockGetClientAddressFromHeaders = jest.fn();
const mockReadTourneySessionFromStore = jest.fn();
const mockDeleteTourneyBracketTeam = jest.fn();
const mockDisqualifyTourneyBracketTeam = jest.fn();
const mockForfeitTourneyBracketMatch = jest.fn();
const mockGenerateTourneyBracket = jest.fn();
const mockGetTourneyBracketSnapshot = jest.fn();
const mockReopenTourneyBracketMatch = jest.fn();
const mockResetTourneyBracket = jest.fn();
const mockScoreTourneyBracketMatch = jest.fn();
const mockSeedTourneyBracketTeams = jest.fn();
const mockUpsertTourneyBracketTeam = jest.fn();

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

jest.mock("../server/tourney/bracketStore", () => ({
  deleteTourneyBracketTeam: (...args) => mockDeleteTourneyBracketTeam(...args),
  disqualifyTourneyBracketTeam: (...args) =>
    mockDisqualifyTourneyBracketTeam(...args),
  forfeitTourneyBracketMatch: (...args) => mockForfeitTourneyBracketMatch(...args),
  generateTourneyBracket: (...args) => mockGenerateTourneyBracket(...args),
  getTourneyBracketSnapshot: (...args) => mockGetTourneyBracketSnapshot(...args),
  reopenTourneyBracketMatch: (...args) => mockReopenTourneyBracketMatch(...args),
  resetTourneyBracket: (...args) => mockResetTourneyBracket(...args),
  scoreTourneyBracketMatch: (...args) => mockScoreTourneyBracketMatch(...args),
  seedTourneyBracketTeams: (...args) => mockSeedTourneyBracketTeams(...args),
  upsertTourneyBracketTeam: (...args) => mockUpsertTourneyBracketTeam(...args),
}));

const { GET, POST } = require("../../app/api/tourney/bracket/route.js");

const snapshot = {
  ok: true,
  generated: true,
  teams: [{ id: "team_1", name: "Alpha" }],
  matches: [],
  groups: [],
  audit: [],
};

const makeJsonRequest = (payload, cookie = "session", contentLength = "") => ({
  url: "https://www.rooindustries.com/api/tourney/bracket",
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

describe("tourney bracket API route", () => {
  beforeEach(() => {
    for (const mock of [
      mockCheckTourneyRateLimit,
      mockGetClientAddressFromHeaders,
      mockReadTourneySessionFromStore,
      mockDeleteTourneyBracketTeam,
      mockDisqualifyTourneyBracketTeam,
      mockForfeitTourneyBracketMatch,
      mockGenerateTourneyBracket,
      mockGetTourneyBracketSnapshot,
      mockReopenTourneyBracketMatch,
      mockResetTourneyBracket,
      mockScoreTourneyBracketMatch,
      mockSeedTourneyBracketTeams,
      mockUpsertTourneyBracketTeam,
    ]) {
      mock.mockReset();
    }

    mockGetClientAddressFromHeaders.mockReturnValue("127.0.0.1");
    mockCheckTourneyRateLimit.mockReturnValue({ ok: true });
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockGetTourneyBracketSnapshot.mockResolvedValue(snapshot);
    mockScoreTourneyBracketMatch.mockResolvedValue(snapshot);
    mockGenerateTourneyBracket.mockResolvedValue(snapshot);
    mockReopenTourneyBracketMatch.mockResolvedValue(snapshot);
  });

  test("allows public read-only bracket access", async () => {
    const response = await GET(makeJsonRequest({}));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(snapshot);
    expect(mockReadTourneySessionFromStore).not.toHaveBeenCalled();
  });

  test("rejects an oversized bracket mutation", async () => {
    const response = await POST(makeJsonRequest({ action: "score-match" }, "session", "32769"));
    expect(response.status).toBe(413);
    expect(mockScoreTourneyBracketMatch).not.toHaveBeenCalled();
  });

  test("allows casters to score matches", async () => {
    const response = await POST(
      makeJsonRequest({
        action: "score-match",
        matchId: 1,
        opponent1Score: 3,
        opponent2Score: 1,
      })
    );

    expect(response.status).toBe(200);
    expect(mockScoreTourneyBracketMatch).toHaveBeenCalledWith({
      matchId: 1,
      opponent1Score: 3,
      opponent2Score: 1,
      actorUsername: "yukari",
    });
  });

  test("blocks casters from owner-only setup actions", async () => {
    const response = await POST(
      makeJsonRequest({
        action: "generate",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe("Owner access required.");
    expect(mockGenerateTourneyBracket).not.toHaveBeenCalled();
  });

  test("allows owners to generate the bracket", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "serviroo",
      role: "owner",
    });

    const response = await POST(makeJsonRequest({ action: "generate" }));

    expect(response.status).toBe(200);
    expect(mockGenerateTourneyBracket).toHaveBeenCalledWith({
      actorUsername: "serviroo",
    });
  });

  test("blocks players from mutating bracket state", async () => {
    mockReadTourneySessionFromStore.mockResolvedValue({
      username: "player",
      role: "player",
    });

    const response = await POST(makeJsonRequest({ action: "score-match" }));

    expect(response.status).toBe(404);
    expect(mockScoreTourneyBracketMatch).not.toHaveBeenCalled();
  });
});
