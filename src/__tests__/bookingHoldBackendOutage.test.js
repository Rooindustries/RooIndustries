const mockCreateCommerceWriteClient = jest.fn();
const mockCreateDataClient = jest.fn();
const mockRequireRateLimit = jest.fn(async () => true);
const mockAssertCommerceStartAllowed = jest.fn(async () => ({ generation: 1 }));
const mockGetBookingSettings = jest.fn(async () => ({}));
const mockIsSlotAllowedForPackage = jest.fn(() => ({
  allowed: true,
  hostDate: "January 5, 2099",
  hostTime: "10:00 AM",
}));

jest.mock("../server/api/ref/sanity.js", () => ({
  createCommerceWriteClient: (...args) =>
    mockCreateCommerceWriteClient(...args),
}));

jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: (...args) => mockCreateDataClient(...args),
}));

jest.mock("../server/api/ref/rateLimit.js", () => ({
  getClientAddress: () => "127.0.0.1",
  requireRateLimit: (...args) => mockRequireRateLimit(...args),
}));

jest.mock("../server/supabase/commerceControl.js", () => ({
  assertCommerceStartAllowed: (...args) =>
    mockAssertCommerceStartAllowed(...args),
}));

jest.mock("../server/supabase/adminClient.js", () => ({
  isSupabaseAdminConfigured: () => true,
}));

jest.mock("../server/booking/slotPolicy.js", () => ({
  getBookingSettings: (...args) => mockGetBookingSettings(...args),
  isSlotAllowedForPackage: (...args) => mockIsSlotAllowedForPackage(...args),
  isBookingBlockingStatus: (status) =>
    !["cancelled", "refunded", "failed", "abandoned"].includes(
      String(status || "").toLowerCase()
    ),
}));

const holdSlotModule = require("../server/booking/holdSlot.js");
const holdSlot = holdSlotModule.default || holdSlotModule;
const { fetchOtherBackendSlotState } = holdSlotModule;
const releaseHoldModule = require("../server/booking/releaseHold.js");
const releaseHold = releaseHoldModule.default || releaseHoldModule;
const { issueHoldToken } = require("../server/booking/holdToken.js");
const { buildSlotHoldId } = require("../server/booking/slotIdentity.js");
const { selectHoldAuthority } = require("../server/booking/holdAuthority.js");

const createResponse = () => {
  const response = {
    body: null,
    statusCode: 200,
    setHeader: jest.fn(),
    status: jest.fn((statusCode) => {
      response.statusCode = statusCode;
      return response;
    }),
    json: jest.fn((body) => {
      response.body = body;
      return response;
    }),
  };
  return response;
};

const createSupabaseClient = ({ existingHold }) => ({
  fetch: jest.fn(async (query, params) => {
    if (query.includes('_type == "slotHold"')) {
      return params?.id === existingHold._id ? existingHold : null;
    }
    if (query.includes('_type == "bookingSlot"')) return null;
    if (query.includes('_type == "booking"')) return [];
    return null;
  }),
  patch: jest.fn(() => {
    let values = {};
    const patch = {
      ifRevisionId: jest.fn(() => patch),
      set: jest.fn((nextValues) => {
        values = nextValues;
        return patch;
      }),
      commit: jest.fn(async () => {
        Object.assign(existingHold, values, { _rev: "supabase-rev-2" });
        return existingHold;
      }),
    };
    return patch;
  }),
  create: jest.fn(),
});

const configureGenerationOne = (client) => {
  process.env.DATA_PRIMARY_BACKEND = "supabase";
  process.env.SUPABASE_CUTOVER_ENABLED = "1";
  process.env.COMMERCE_PRIMARY_BACKEND = "supabase";
  process.env.COMMERCE_CUTOVER_ENABLED = "1";
  process.env.COMMERCE_FAILOVER_GENERATION = "1";
  process.env.SANITY_REVERSE_MIRROR_WRITES = "1";
  mockCreateCommerceWriteClient.mockImplementation(({ backendOverride }) => {
    if (backendOverride === "sanity") throw new Error("Sanity unavailable");
    return client;
  });
  mockCreateDataClient.mockImplementation((_config, { backendOverride }) => {
    if (backendOverride === "sanity") throw new Error("Sanity unavailable");
    return client;
  });
};

const configureGenerationTwoSanity = (client) => {
  process.env.DATA_PRIMARY_BACKEND = "sanity";
  process.env.COMMERCE_PRIMARY_BACKEND = "sanity";
  process.env.COMMERCE_CUTOVER_ENABLED = "1";
  process.env.COMMERCE_FAILOVER_GENERATION = "2";
  mockAssertCommerceStartAllowed.mockResolvedValue({ generation: 2 });
  mockCreateCommerceWriteClient.mockImplementation(({ backendOverride }) => {
    if (backendOverride === "supabase") throw new Error("Supabase unavailable");
    return client;
  });
  mockCreateDataClient.mockImplementation((_config, { backendOverride }) => {
    if (backendOverride === "supabase") throw new Error("Supabase unavailable");
    return client;
  });
};

const clearEnvironment = () => {
  for (const key of [
    "DATA_PRIMARY_BACKEND",
    "SUPABASE_CUTOVER_ENABLED",
    "COMMERCE_PRIMARY_BACKEND",
    "COMMERCE_CUTOVER_ENABLED",
    "COMMERCE_FAILOVER_GENERATION",
    "SANITY_REVERSE_MIRROR_WRITES",
  ]) {
    delete process.env[key];
  }
};

describe("booking hold backend isolation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertCommerceStartAllowed.mockResolvedValue({ generation: 1 });
  });

  afterEach(() => {
    clearEnvironment();
  });

  test("does not read Sanity after the generation-one Supabase cutover", async () => {
    const existingHold = { _id: "hold-1" };
    const client = createSupabaseClient({ existingHold });
    configureGenerationOne(client);

    await expect(
      fetchOtherBackendSlotState({
        backend: "supabase",
        holdId: "hold-1",
        slotLockId: "slot-1",
        startTimeUTC: "2099-01-05T04:30:00.000Z",
      })
    ).resolves.toEqual({ hold: null, slotLock: null, bookings: [] });
    expect(mockCreateCommerceWriteClient).not.toHaveBeenCalled();
  });

  test.each([
    ["valid", "2099-01-05T05:00:00.000Z", 200],
    ["expired", "2020-01-05T05:00:00.000Z", 409],
  ])(
    "routes a %s signed Sanity hold token through Supabase",
    async (_label, tokenExpiry, expectedStatus) => {
      const startTimeUTC = "2099-01-05T04:30:00.000Z";
      const holdId = buildSlotHoldId(startTimeUTC);
      const existingHold = {
        _id: holdId,
        _rev: "sanity-rev-1",
        _type: "slotHold",
        startTimeUTC,
        expiresAt: "2099-01-05T05:00:00.000Z",
        holdNonce: "legacy-nonce",
        phase: "active",
        backendOwner: "sanity",
        cutoverGeneration: 0,
      };
      const client = createSupabaseClient({ existingHold });
      configureGenerationOne(client);
      const holdToken = issueHoldToken({
        holdId,
        startTimeUTC,
        expiresAt: tokenExpiry,
        holdNonce: "legacy-nonce",
        backend: "sanity",
        cutoverGeneration: 0,
      });
      const response = createResponse();

      await holdSlot(
        {
          method: "POST",
          body: {
            startTimeUTC,
            packageTitle: "Test Package",
            previousHoldId: holdId,
            previousHoldToken: holdToken,
          },
          headers: {},
        },
        response
      );

      expect(response.statusCode).toBe(expectedStatus);
      expect(mockCreateCommerceWriteClient).toHaveBeenCalledWith({
        backendOverride: "supabase",
      });
      expect(mockCreateCommerceWriteClient).not.toHaveBeenCalledWith({
        backendOverride: "sanity",
      });
    }
  );

  test.each([
    ["valid", "2099-01-05T05:00:00.000Z", 200],
    ["expired", "2020-01-05T05:00:00.000Z", 403],
  ])(
    "releases a %s signed Sanity hold token against the Supabase mirror",
    async (_label, tokenExpiry, expectedStatus) => {
      const startTimeUTC = "2099-01-05T04:30:00.000Z";
      const holdId = buildSlotHoldId(startTimeUTC);
      const existingHold = {
        _id: holdId,
        _rev: "sanity-rev-1",
        startTimeUTC,
        expiresAt: "2099-01-05T05:00:00.000Z",
        holdNonce: "legacy-nonce",
        phase: "active",
        backendOwner: "sanity",
        cutoverGeneration: 0,
      };
      const client = createSupabaseClient({ existingHold });
      configureGenerationOne(client);
      const holdToken = issueHoldToken({
        holdId,
        startTimeUTC,
        expiresAt: tokenExpiry,
        holdNonce: "legacy-nonce",
        backend: "sanity",
        cutoverGeneration: 0,
      });
      const response = createResponse();

      await releaseHold(
        {
          method: "POST",
          body: { holdId, holdToken },
          headers: {},
        },
        response
      );

      expect(response.statusCode).toBe(expectedStatus);
      expect(mockCreateDataClient).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ backendOverride: "supabase" })
      );
      expect(mockCreateDataClient).not.toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ backendOverride: "sanity" })
      );
    }
  );

  test("selects the configured Sanity authority after manual failover", () => {
    expect(
      selectHoldAuthority({
        tokenPayload: { hid: "hold-1", be: "supabase", gen: 1 },
        policy: {
          commercePrimaryBackend: "sanity",
          commerceFailoverGeneration: 2,
        },
      })
    ).toBe("sanity");
  });

  test("refreshes a Supabase hold only through Sanity after manual failover", async () => {
    const startTimeUTC = "2099-01-05T04:30:00.000Z";
    const holdId = buildSlotHoldId(startTimeUTC);
    const existingHold = {
      _id: holdId,
      _rev: "supabase-rev-1",
      _type: "slotHold",
      startTimeUTC,
      expiresAt: "2099-01-05T05:00:00.000Z",
      holdNonce: "supabase-nonce",
      phase: "active",
      backendOwner: "supabase",
      cutoverGeneration: 1,
    };
    const client = createSupabaseClient({ existingHold });
    configureGenerationTwoSanity(client);
    const holdToken = issueHoldToken({
      holdId,
      startTimeUTC,
      expiresAt: existingHold.expiresAt,
      holdNonce: existingHold.holdNonce,
      backend: "supabase",
      cutoverGeneration: 1,
    });
    const response = createResponse();

    await holdSlot(
      {
        method: "POST",
        body: {
          startTimeUTC,
          packageTitle: "Test Package",
          previousHoldId: holdId,
          previousHoldToken: holdToken,
        },
        headers: {},
      },
      response
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      backend: "sanity",
      cutoverGeneration: 2,
    });
    expect(mockCreateCommerceWriteClient).toHaveBeenCalledWith({
      backendOverride: "sanity",
    });
    expect(mockCreateCommerceWriteClient).not.toHaveBeenCalledWith({
      backendOverride: "supabase",
    });
  });

  test("releases a Supabase hold only through Sanity after manual failover", async () => {
    const startTimeUTC = "2099-01-05T04:30:00.000Z";
    const holdId = buildSlotHoldId(startTimeUTC);
    const existingHold = {
      _id: holdId,
      _rev: "supabase-rev-1",
      startTimeUTC,
      expiresAt: "2099-01-05T05:00:00.000Z",
      holdNonce: "supabase-nonce",
      phase: "active",
      backendOwner: "supabase",
      cutoverGeneration: 1,
    };
    const client = createSupabaseClient({ existingHold });
    configureGenerationTwoSanity(client);
    const holdToken = issueHoldToken({
      holdId,
      startTimeUTC,
      expiresAt: existingHold.expiresAt,
      holdNonce: existingHold.holdNonce,
      backend: "supabase",
      cutoverGeneration: 1,
    });
    const response = createResponse();

    await releaseHold(
      {
        method: "POST",
        body: { holdId, holdToken },
        headers: {},
      },
      response
    );

    expect(response.statusCode).toBe(200);
    expect(mockCreateDataClient).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ backendOverride: "sanity" })
    );
    expect(mockCreateDataClient).not.toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ backendOverride: "supabase" })
    );
  });
});
