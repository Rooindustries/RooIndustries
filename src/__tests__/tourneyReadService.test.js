const mockListManageTourneyPlayers = jest.fn();
const mockGetTourneyRoleCapacitySnapshot = jest.fn();

jest.mock("../server/tourney/appealPayoutStore", () => ({
  listTourneyAppealsForSession: jest.fn(),
  listTourneyPayoutsForSession: jest.fn(),
}));
jest.mock("../server/tourney/bracketStore", () => ({
  getTourneyBracketSnapshot: jest.fn(),
}));
jest.mock("../server/tourney/playerStore", () => ({
  getTourneyRoleCapacitySnapshot: (...args) =>
    mockGetTourneyRoleCapacitySnapshot(...args),
  listApprovedTourneyPlayers: jest.fn(),
  listManageTourneyPlayers: (...args) => mockListManageTourneyPlayers(...args),
}));

const {
  readAdminTourneyPlayers,
} = require("../server/tourney/readService.js");

describe("Tourney read services", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("reads admin players and capacity concurrently", async () => {
    let resolvePlayers;
    let resolveCapacity;
    mockListManageTourneyPlayers.mockReturnValue(new Promise((resolve) => {
      resolvePlayers = resolve;
    }));
    mockGetTourneyRoleCapacitySnapshot.mockReturnValue(new Promise((resolve) => {
      resolveCapacity = resolve;
    }));

    const env = { TOURNEY_DATABASE_MODE: "supabase" };
    const pending = readAdminTourneyPlayers({ env });

    expect(mockListManageTourneyPlayers).toHaveBeenCalledWith({ env });
    expect(mockGetTourneyRoleCapacitySnapshot).toHaveBeenCalledWith({ env });

    resolvePlayers([{ id: "player-1" }]);
    resolveCapacity({ tank: { remaining: 2 } });

    await expect(pending).resolves.toEqual({
      ok: true,
      players: [{ id: "player-1" }],
      capacity: { tank: { remaining: 2 } },
    });
  });

  test("preserves the default environment call contract", async () => {
    mockListManageTourneyPlayers.mockResolvedValue([{ id: "player-2" }]);
    mockGetTourneyRoleCapacitySnapshot.mockResolvedValue({
      healer: { remaining: 1 },
    });

    await expect(readAdminTourneyPlayers()).resolves.toEqual({
      ok: true,
      players: [{ id: "player-2" }],
      capacity: { healer: { remaining: 1 } },
    });
    expect(mockListManageTourneyPlayers).toHaveBeenCalledWith();
    expect(mockGetTourneyRoleCapacitySnapshot).toHaveBeenCalledWith();
  });
});
