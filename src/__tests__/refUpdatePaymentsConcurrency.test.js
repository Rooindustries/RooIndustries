const mockReadFetch = jest.fn();
const mockWriteFetch = jest.fn();
const mockPatch = jest.fn();
const mockGetDocument = jest.fn();
const mockTransaction = jest.fn();
const mockCommit = jest.fn();
const mockRequireAdminKey = jest.fn();
const mockFetchReferralEarnings = jest.fn();

jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: () => ({
    fetch: (...args) =>
      String(args[0]).includes('"package"')
        ? mockReadFetch(...args)
        : mockWriteFetch(...args),
    patch: (...args) => mockPatch(...args),
    getDocument: (...args) => mockGetDocument(...args),
    transaction: (...args) => mockTransaction(...args),
  }),
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

describe("D6/O1 native referral payment update concurrency", () => {
  let receipts;

  beforeEach(() => {
    jest.clearAllMocks();
    receipts = new Map();
    mockGetDocument.mockImplementation(async (id) => receipts.get(id) || null);
    mockTransaction.mockImplementation(() => {
      let receipt;
      let referralPatch;
      const transaction = {
        create(document) {
          receipt = document;
          return transaction;
        },
        patch(id, buildPatch) {
          expect(id).toBe(receipt.referralId);
          referralPatch = buildPatch();
          return transaction;
        },
        commit: () => mockCommit(receipt, referralPatch),
      };
      return transaction;
    });
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
      const patch = {
        revision: "",
        values: {},
        ifRevisionId(revisionId) {
          patch.revision = revisionId;
          revisions.push(revisionId);
          return patch;
        },
        set(values) {
          Object.assign(patch.values, values);
          return patch;
        },
      };
      return patch;
    });
    mockCommit.mockImplementation(async (receipt, patch) => {
      committedSets.push(patch.values);
      if (patch.revision === "revision-one") throw revisionConflict();
      receipts.set(receipt._id, receipt);
      return { _rev: "revision-three" };
    });

    const response = createResponse();
    await handler(
      {
        method: "POST",
        body: {
          referralId: "referral.creator",
          packageType: "xoc",
          amount: 20,
          payoutId: "concurrent-transfer",
          paidOn: "2026-07-18T01:00:00.000Z",
        },
      },
      response
    );

    expect(response.statusCode).toBe(200);
    expect(revisions).toEqual(["revision-one", "revision-two"]);
    expect(committedSets[1].xocPayments).toEqual([
      concurrentEntry,
      expect.objectContaining({
        _key: "concurrent-transfer",
        amount: 20,
        _type: "paymentLogXoc",
      }),
    ]);
    expect(committedSets[1]).toMatchObject({ paidXoc: 30, paidTotal: 30 });
    expect(response.body.logs.xoc).toEqual(committedSets[1].xocPayments);
    expect(mockTransaction).toHaveBeenCalledTimes(2);
    expect(receipts.size).toBe(1);
    expect([...receipts.values()][0]).toMatchObject({
      referralId: "referral.creator",
      amount: 20,
      paymentEntry: committedSets[1].xocPayments[1],
    });
  });

  test("returns a conflict after bounded revision retries", async () => {
    mockWriteFetch
      .mockResolvedValueOnce(referral("revision-one"))
      .mockResolvedValueOnce(referral("revision-two"))
      .mockResolvedValueOnce(referral("revision-three"))
      .mockResolvedValue(referral("revision-four"));
    mockPatch.mockImplementation(() => {
      const patch = {
        ifRevisionId: () => patch,
        set: () => patch,
      };
      return patch;
    });
    mockCommit.mockRejectedValue(revisionConflict());

    const response = createResponse();
    await handler(
      {
        method: "POST",
        body: {
          referralId: "referral.creator",
          packageType: "vertex",
          amount: 25,
          payoutId: "conflicted-transfer",
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
    expect(mockTransaction).toHaveBeenCalledTimes(3);
    expect(mockCommit).toHaveBeenCalledTimes(3);
    expect(mockWriteFetch).toHaveBeenCalledTimes(4);
    expect(mockGetDocument).toHaveBeenCalledTimes(4);
    expect(receipts.size).toBe(0);
  });
});
