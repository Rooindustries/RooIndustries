const mockGetSql = jest.fn();
const mockAssertSchema = jest.fn();
const mockSanityFetch = jest.fn();

jest.mock("../server/tourney/sqlClient.js", () => ({
  assertTourneySchemaVersion: (...args) => mockAssertSchema(...args),
  getTourneySql: (...args) => mockGetSql(...args),
}));

jest.mock("../server/tourney/store.js", () => ({
  resolveTourneyStorePolicy: () => ({ primaryBackend: "supabase" }),
}));

jest.mock("../server/tourney/externalOperations.js", () => ({
  enqueueTourneyExternalOperation: jest.fn(),
}));

jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: () => ({ fetch: (...args) => mockSanityFetch(...args) }),
}));

const { readPersistedTourneyAccountsJson } = require("../server/tourney/accountStore.js");

const env = {
  NODE_ENV: "production",
  TOURNEY_DATABASE_MODE: "supabase",
  TOURNEY_HARDENING_V4_ENABLED: "1",
  SUPABASE_DATABASE_URL: "postgres://fixture",
  SANITY_WRITE_TOKEN: "fixture",
};

describe("hardened Tourney account authority", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertSchema.mockResolvedValue(true);
    mockSanityFetch.mockResolvedValue({ accountsJson: "[]" });
  });

  test("fails closed when the authoritative database snapshot is empty", async () => {
    const sql = jest.fn((input) =>
      typeof input === "string" ? input : Promise.resolve([])
    );
    mockGetSql.mockResolvedValue(sql);

    await expect(readPersistedTourneyAccountsJson(env)).rejects.toMatchObject({
      code: "TOURNEY_ACCOUNT_SNAPSHOT_REQUIRED",
      status: 503,
    });
    expect(mockSanityFetch).not.toHaveBeenCalled();
  });

  test("does not hide a missing hardened table behind Sanity", async () => {
    const missing = Object.assign(new Error("missing relation"), { code: "42P01" });
    mockGetSql.mockRejectedValue(missing);

    await expect(readPersistedTourneyAccountsJson(env)).rejects.toBe(missing);
    expect(mockSanityFetch).not.toHaveBeenCalled();
  });
});
