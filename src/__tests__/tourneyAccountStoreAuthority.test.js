const mockGetSql = jest.fn();
const mockAssertSchema = jest.fn();
const mockSanityFetch = jest.fn();
const mockSanityCreateIfNotExists = jest.fn();
const mockSanityPatchCommit = jest.fn();
const mockSanityPatchSet = jest.fn(() => ({ commit: mockSanityPatchCommit }));
const mockSanityPatch = jest.fn(() => ({ set: mockSanityPatchSet }));
const sanityReadClient = {
  fetch: (...args) => mockSanityFetch(...args),
};
const sanityWriteClient = {
  createIfNotExists: (...args) => mockSanityCreateIfNotExists(...args),
  patch: (...args) => mockSanityPatch(...args),
};
const mockCreateDocumentReadClient = jest.fn(() => sanityReadClient);
const mockCreateDocumentWriteClient = jest.fn(() => sanityWriteClient);

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
  createDocumentReadClient: (...args) => mockCreateDocumentReadClient(...args),
  createDocumentWriteClient: (...args) => mockCreateDocumentWriteClient(...args),
}));

const {
  projectTourneyAccountSnapshotToSanity,
  readPersistedTourneyAccountsJson,
} = require("../server/tourney/accountStore.js");

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
    mockSanityCreateIfNotExists.mockResolvedValue({ _id: "tourneyAuthStore" });
    mockSanityPatchCommit.mockResolvedValue({ _id: "tourneyAuthStore" });
    mockSanityPatchSet.mockReturnValue({ commit: mockSanityPatchCommit });
    mockSanityPatch.mockReturnValue({ set: mockSanityPatchSet });
    mockCreateDocumentReadClient.mockReturnValue(sanityReadClient);
    mockCreateDocumentWriteClient.mockReturnValue(sanityWriteClient);
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

  test("requests an explicit Sanity read target for the compatibility fallback", async () => {
    mockGetSql.mockRejectedValue(Object.assign(new Error("missing relation"), {
      code: "42P01",
    }));
    await expect(readPersistedTourneyAccountsJson({
      ...env,
      TOURNEY_HARDENING_V4_ENABLED: "0",
      SANITY_PRIVATE_PROJECT_ID: "private-project",
      SANITY_PROJECT_ID: "standard-project",
      NEXT_PUBLIC_SANITY_PROJECT_ID: "public-project",
      SANITY_PRIVATE_DATASET: "private_dataset",
      SANITY_DATASET: "standard_dataset",
      NEXT_PUBLIC_SANITY_DATASET: "public_dataset",
      SANITY_PRIVATE_WRITE_TOKEN: "private-token",
      SANITY_WRITE_TOKEN: "standard-token",
    })).resolves.toBe("[]");
    expect(mockCreateDocumentReadClient).toHaveBeenCalledWith({
      env: expect.objectContaining({
        SANITY_PRIVATE_PROJECT_ID: "private-project",
        SANITY_PRIVATE_DATASET: "private_dataset",
        SANITY_PRIVATE_WRITE_TOKEN: "private-token",
      }),
      backendOverride: "sanity",
      perspective: "published",
    });
    expect(mockCreateDocumentWriteClient).not.toHaveBeenCalled();
  });

  test("projects through an explicit Sanity writer under global Supabase", async () => {
    const projectionEnv = {
      ...env,
      DATA_PRIMARY_BACKEND: "supabase",
      COMMERCE_PRIMARY_BACKEND: "supabase",
      SUPABASE_CUTOVER_ENABLED: "1",
      COMMERCE_CUTOVER_ENABLED: "1",
      SANITY_REVERSE_MIRROR_WRITES: "1",
      SANITY_PROJECT_ID: "sanity-project",
      SANITY_DATASET: "production",
    };

    await expect(projectTourneyAccountSnapshotToSanity({
      accountsJson: "[]",
      actorUsername: "owner",
      env: projectionEnv,
    })).resolves.toMatchObject({ ok: true, provider: "sanity" });
    expect(mockCreateDocumentWriteClient).toHaveBeenCalledWith({
      env: projectionEnv,
      backendOverride: "sanity",
    });
    expect(mockCreateDocumentReadClient).not.toHaveBeenCalled();
    expect(mockSanityCreateIfNotExists).toHaveBeenCalledTimes(1);
    expect(mockSanityPatchCommit).toHaveBeenCalledTimes(1);
  });

  test("does not report success when the Sanity provider fails", async () => {
    const providerError = Object.assign(new Error("Sanity unavailable"), {
      code: "SANITY_UNAVAILABLE",
    });
    mockSanityPatchCommit.mockRejectedValueOnce(providerError);

    await expect(projectTourneyAccountSnapshotToSanity({
      accountsJson: "[]",
      actorUsername: "owner",
      env: {
        ...env,
        SANITY_PROJECT_ID: "sanity-project",
        SANITY_DATASET: "production",
      },
    })).rejects.toBe(providerError);
    expect(mockSanityPatchCommit).toHaveBeenCalledTimes(1);
  });

  test("fails before provider work when an explicit Sanity writer is unavailable", async () => {
    const configurationError = new Error("Sanity write access is not configured.");
    mockCreateDocumentWriteClient.mockImplementationOnce(() => {
      throw configurationError;
    });

    await expect(projectTourneyAccountSnapshotToSanity({
      accountsJson: "[]",
      actorUsername: "owner",
      env,
    })).rejects.toBe(configurationError);
    expect(mockSanityCreateIfNotExists).not.toHaveBeenCalled();
    expect(mockSanityPatch).not.toHaveBeenCalled();
  });
});
