const mockReadFetch = jest.fn();
const mockWriteFetch = jest.fn();
const mockPatch = jest.fn();
const mockRequireAdminKey = jest.fn();
const mockFetchReferralEarnings = jest.fn();

jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: (config) =>
    config.perspective
      ? { fetch: (...args) => mockReadFetch(...args) }
      : {
          fetch: (...args) => mockWriteFetch(...args),
          patch: (...args) => mockPatch(...args),
        },
}));

jest.mock("../server/api/ref/auth.js", () => ({
  requireAdminKey: (...args) => mockRequireAdminKey(...args),
}));

jest.mock("../server/api/ref/payoutUtils.js", () => ({
  ...jest.requireActual("../server/api/ref/payoutUtils.js"),
  fetchReferralEarnings: (...args) => mockFetchReferralEarnings(...args),
}));

jest.mock("../server/safeErrorLog.js", () => ({ logSafeError: jest.fn() }));

const handlerModule = require("../server/api/ref/updatePayments.js");
const handler = handlerModule.default || handlerModule;

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

const referral = (revision, xocPayments = []) => ({
  _id: "referral.creator",
  _rev: revision,
  name: "Creator",
  slug: { current: "creator" },
  xocPayments,
  vertexPayments: [],
});

const revisionConflict = () =>
  Object.assign(new Error("Revision changed"), { statusCode: 409 });

describe("referral payment update concurrency", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminKey.mockReturnValue(true);
    mockReadFetch.mockResolvedValue([]);
    mockFetchReferralEarnings.mockResolvedValue({
      xoc: 100,
      vertex: 0,
      total: 100,
      byPackage: {},
    });
  });

  test("retries against the latest revision without dropping a concurrent entry", async () => {
    const concurrentEntry = {
      _key: "concurrent-payment",
      _type: "paymentLogXoc",
      amount: 10,
      paidOn: "2026-07-18T00:00:00.000Z",
    };
    mockWriteFetch
      .mockResolvedValueOnce(referral("revision-one"))
      .mockResolvedValueOnce(referral("revision-two", [concurrentEntry]));

    const revisions = [];
    const committedSets = [];
    mockPatch.mockImplementation(() => {
      const operations = { revision: "", values: {} };
      const patch = {
        ifRevisionId(revisionId) {
          operations.revision = revisionId;
          revisions.push(revisionId);
          return patch;
        },
        set(values) {
          Object.assign(operations.values, values);
          return patch;
        },
        async commit() {
          committedSets.push(operations.values);
          if (operations.revision === "revision-one") throw revisionConflict();
          return { _rev: "revision-three" };
        },
      };
      return patch;
    });

    const response = createResponse();
    await handler(
      {
        method: "POST",
        body: {
          referralId: "referral.creator",
          packageType: "xoc",
          amount: 20,
          paidOn: "2026-07-18T01:00:00.000Z",
        },
      },
      response
    );

    expect(response.statusCode).toBe(200);
    expect(revisions).toEqual(["revision-one", "revision-two"]);
    expect(committedSets[1].xocPayments).toEqual([
      concurrentEntry,
      expect.objectContaining({ amount: 20, _type: "paymentLogXoc" }),
    ]);
    expect(committedSets[1]).toMatchObject({ paidXoc: 30, paidTotal: 30 });
    expect(response.body.logs.xoc).toEqual(committedSets[1].xocPayments);
  });

  test("returns a conflict after bounded revision retries", async () => {
    mockWriteFetch
      .mockResolvedValueOnce(referral("revision-one"))
      .mockResolvedValueOnce(referral("revision-two"))
      .mockResolvedValueOnce(referral("revision-three"));
    mockPatch.mockImplementation(() => {
      const patch = {
        ifRevisionId: () => patch,
        set: () => patch,
        commit: async () => {
          throw revisionConflict();
        },
      };
      return patch;
    });

    const response = createResponse();
    await handler(
      {
        method: "POST",
        body: {
          referralId: "referral.creator",
          packageType: "vertex",
          amount: 25,
        },
      },
      response
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      ok: false,
      error: "Payment data changed while saving. Please try again.",
    });
    expect(mockPatch).toHaveBeenCalledTimes(3);
    expect(mockWriteFetch).toHaveBeenCalledTimes(3);
  });
});
