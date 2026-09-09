const mockRequireReferralSession = jest.fn();
const mockRequireAdminKey = jest.fn();
const mockCreateCommerceReadClient = jest.fn();
const mockCreateCommerceWriteClient = jest.fn();
const mockFetchReferralEarnings = jest.fn();
const mockAssertCommerceWriteAllowed = jest.fn();

jest.mock("../server/api/ref/auth.js", () => ({
  requireReferralSession: (...args) => mockRequireReferralSession(...args),
  requireAdminKey: (...args) => mockRequireAdminKey(...args),
}));

jest.mock("../server/api/ref/sanity.js", () => ({
  createCommerceReadClient: (...args) =>
    mockCreateCommerceReadClient(...args),
  createCommerceWriteClient: (...args) =>
    mockCreateCommerceWriteClient(...args),
}));

jest.mock("../server/api/ref/payoutUtils.js", () => {
  const actual = jest.requireActual("../server/api/ref/payoutUtils.js");
  return {
    ...actual,
    fetchReferralEarnings: (...args) => mockFetchReferralEarnings(...args),
  };
});

jest.mock("../server/supabase/commerceControl.js", () => ({
  assertCommerceWriteAllowed: (...args) =>
    mockAssertCommerceWriteAllowed(...args),
}));

const payoutsHandler = require("../server/api/ref/payouts.js").default;
const syncPayoutsHandler = require("../server/api/ref/syncPayouts.js").default;

const referral = {
  _id: "referral-1",
  name: "Creator",
  slug: { current: "creator" },
  xocPayments: [],
  vertexPayments: [],
};

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const createClients = () => {
  const readClient = {
    fetch: jest.fn((query) =>
      Promise.resolve(String(query).includes('_type == "referral"') ? referral : [])
    ),
  };
  const commit = jest.fn().mockResolvedValue({ _id: referral._id });
  const patch = {
    set: jest.fn(() => patch),
    commit,
  };
  const writeClient = { patch: jest.fn(() => patch) };
  mockCreateCommerceReadClient.mockReturnValue(readClient);
  mockCreateCommerceWriteClient.mockReturnValue(writeClient);
  return { readClient, writeClient, commit };
};

describe("referral payout backend selection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SANITY_PROJECT_ID;
    delete process.env.SANITY_DATASET;
    delete process.env.SANITY_READ_TOKEN;
    delete process.env.SANITY_WRITE_TOKEN;
    mockRequireReferralSession.mockResolvedValue({ referralId: referral._id });
    mockRequireAdminKey.mockReturnValue(true);
    mockAssertCommerceWriteAllowed.mockResolvedValue({
      primaryBackend: "supabase",
      generation: 1,
      startsPaused: false,
    });
    mockFetchReferralEarnings.mockResolvedValue({
      xoc: 0,
      vertex: 0,
      total: 0,
      byPackage: {},
    });
  });

  test("the creator payout read is strictly read-only", async () => {
    const { commit } = createClients();
    const response = createResponse();

    await payoutsHandler({ method: "GET" }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body.sync).toEqual({ attempted: false, success: true, error: "" });
    expect(mockCreateCommerceReadClient).toHaveBeenCalledTimes(1);
    expect(mockCreateCommerceWriteClient).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  test("repeated unchanged payout reads produce no writes", async () => {
    const { commit } = createClients();
    await payoutsHandler({ method: "GET" }, createResponse());
    await payoutsHandler({ method: "GET" }, createResponse());
    expect(mockCreateCommerceWriteClient).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  test("admin payout sync no longer requires a standard Sanity token", async () => {
    const { commit } = createClients();
    const response = createResponse();

    await syncPayoutsHandler(
      { method: "POST", body: { referralId: referral._id } },
      response
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(mockAssertCommerceWriteAllowed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response.body)).not.toContain("SANITY_WRITE_TOKEN");
    expect(commit).toHaveBeenCalledTimes(1);
  });

  test("admin payout sync produces no write while commerce is paused", async () => {
    const { commit } = createClients();
    mockAssertCommerceWriteAllowed.mockRejectedValueOnce(
      Object.assign(new Error("paused"), {
        code: "COMMERCE_STARTS_PAUSED",
        status: 503,
      })
    );
    const response = createResponse();

    await syncPayoutsHandler(
      { method: "POST", body: { referralId: referral._id } },
      response
    );

    expect(response.statusCode).toBe(503);
    expect(mockCreateCommerceReadClient).not.toHaveBeenCalled();
    expect(mockCreateCommerceWriteClient).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  test.each([
    ["creator read", payoutsHandler, { method: "GET" }, 0],
    ["admin sync", syncPayoutsHandler, {
      method: "POST", body: { referralId: referral._id },
    }, 1],
  ])("%s overlaps independent reads and preserves payout balances", async (
    _name, handler, request, expectedWrites
  ) => {
    const { readClient, commit } = createClients();
    const earnings = {
      xoc: 12.5, vertex: 7, total: 19.5,
      byPackage: { "Performance Vertex Max": 12.5, "Retired package": 7 },
    };
    const payments = [{ amount: 15 }];
    let releaseEarnings;
    let releaseCatalog;
    let notifyEarningsStarted;
    const earningsPending = new Promise((resolve) => { releaseEarnings = resolve; });
    const catalogPending = new Promise((resolve) => { releaseCatalog = resolve; });
    const earningsStarted = new Promise((resolve) => { notifyEarningsStarted = resolve; });
    mockFetchReferralEarnings.mockImplementation(() => {
      notifyEarningsStarted();
      return earningsPending;
    });
    readClient.fetch.mockImplementation((query) => {
      if (String(query).includes('_type == "referral"')) {
        return Promise.resolve({ ...referral, xocPayments: payments });
      }
      return catalogPending;
    });
    const response = createResponse();

    const pending = handler(request, response);
    await earningsStarted;
    try {
      expect(readClient.fetch).toHaveBeenCalledWith(
        expect.stringContaining('_type == "package"')
      );
      expect(commit).not.toHaveBeenCalled();
    } finally {
      releaseEarnings(earnings);
      releaseCatalog([
        { title: "Performance Vertex Max", order: 1 },
        { title: "New package", order: 2 },
      ]);
      await pending;
    }

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      earnings,
      packageBreakdown: [
        { title: "Performance Vertex Max", amount: 12.5 },
        { title: "New package", amount: 0 },
        { title: "Retired package", amount: 7 },
      ],
      payments: { xoc: 15, vertex: 0, total: 15 },
      remaining: { xoc: -2.5, vertex: 7, total: 4.5 },
      owed: { xoc: 0, vertex: 7, total: 4.5 },
      overpaid: { xoc: 2.5, vertex: 0, total: 0 },
      logs: { xoc: payments, vertex: [] },
    });
    expect(commit).toHaveBeenCalledTimes(expectedWrites);
  });

  test.each(["earnings", "catalog"])(
    "admin sync does not write when the %s read fails",
    async (failedRead) => {
      const { readClient, commit } = createClients();
      const failure = new Error("fixture read unavailable");
      if (failedRead === "earnings") {
        mockFetchReferralEarnings.mockRejectedValueOnce(failure);
      } else {
        readClient.fetch.mockImplementation((query) =>
          String(query).includes('_type == "referral"')
            ? Promise.resolve(referral)
            : Promise.reject(failure)
        );
      }
      const response = createResponse();

      await syncPayoutsHandler({
        method: "POST", body: { referralId: referral._id },
      }, response);

      expect(response.statusCode).toBe(500);
      expect(response.body).toEqual({ ok: false, error: "Server error" });
      expect(commit).not.toHaveBeenCalled();
    }
  );
});
