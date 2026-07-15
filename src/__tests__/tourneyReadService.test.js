const mockGetManageTourneyPlayersSnapshot = jest.fn();

jest.mock("../server/tourney/appealPayoutStore", () => ({
  listTourneyAppealsForSession: jest.fn(),
  listTourneyPayoutsForSession: jest.fn(),
}));
jest.mock("../server/tourney/bracketStore", () => ({
  getTourneyBracketSnapshot: jest.fn(),
}));
jest.mock("../server/tourney/playerStore", () => ({
  getManageTourneyPlayersSnapshot: (...args) =>
    mockGetManageTourneyPlayersSnapshot(...args),
  listApprovedTourneyPlayers: jest.fn(),
}));

const {
  readAdminTourneyPlayers,
} = require("../server/tourney/readService.js");

describe("Tourney read services", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("reads admin players and capacity from one snapshot", async () => {
    const env = { TOURNEY_DATABASE_MODE: "supabase" };
    mockGetManageTourneyPlayersSnapshot.mockResolvedValue({
      players: [{ id: "player-1" }],
      capacity: { tank: { remaining: 2 } },
    });
    await expect(readAdminTourneyPlayers({ env })).resolves.toEqual({
      ok: true,
      players: [{ id: "player-1" }],
      capacity: { tank: { remaining: 2 } },
    });
    expect(mockGetManageTourneyPlayersSnapshot).toHaveBeenCalledTimes(1);
    expect(mockGetManageTourneyPlayersSnapshot).toHaveBeenCalledWith({ env });
  });

  test("preserves the default environment call contract", async () => {
    mockGetManageTourneyPlayersSnapshot.mockResolvedValue({
      players: [{ id: "player-2" }],
      capacity: { healer: { remaining: 1 } },
    });

    await expect(readAdminTourneyPlayers()).resolves.toEqual({
      ok: true,
      players: [{ id: "player-2" }],
      capacity: { healer: { remaining: 1 } },
    });
    expect(mockGetManageTourneyPlayersSnapshot).toHaveBeenCalledWith();
  });
});
