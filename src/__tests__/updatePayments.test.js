const mockReadFetch = jest.fn();
const mockWriteFetch = jest.fn();
const mockPatch = jest.fn();
const mockGetDocument = jest.fn();
const mockTransaction = jest.fn();
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

const paymentEntry = (key, amount, type) => ({
  _key: key,
  _type: type,
  amount,
  paidOn: "2026-07-01T00:00:00.000Z",
});

const referral = ({ xocPayments = [], vertexPayments = [] } = {}) => ({
  _id: "referral.account",
  _rev: "revision-one",
  name: "Referral account",
  slug: { current: "referral-account" },
  xocPayments,
  vertexPayments,
});

describe("admin referral payment updates", () => {
  let committedValues;
  let committedReceipt;

  beforeEach(() => {
    jest.clearAllMocks();
    committedValues = null;
    committedReceipt = null;
    const receipts = new Map();
    mockGetDocument.mockImplementation(async (id) => receipts.get(id) || null);
    mockRequireAdminKey.mockReturnValue(true);
    mockReadFetch.mockResolvedValue([]);
    mockFetchReferralEarnings.mockResolvedValue({
      xoc: 100,
      vertex: 50,
      total: 150,
      byPackage: {},
    });
    mockPatch.mockImplementation(() => {
      const patch = {
        values: {},
        ifRevisionId: () => patch,
        set(nextValues) {
          Object.assign(patch.values, nextValues);
          return patch;
        },
      };
      return patch;
    });
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
        async commit() {
          if (receipts.has(receipt._id)) {
            throw Object.assign(new Error("Receipt already exists"), {
              statusCode: 409,
            });
          }
          committedValues = referralPatch.values;
          committedReceipt = receipt;
          receipts.set(receipt._id, receipt);
          return { _rev: "revision-two" };
        },
      };
      return transaction;
    });
  });

  test("appends a new entry and recomputes paid and owed totals", async () => {
    const existingXoc = paymentEntry("xoc-existing", 10, "paymentLogXoc");
    const existingVertex = paymentEntry(
      "vertex-existing",
      5,
      "paymentLogVertex"
    );
    const initialReferral = referral({
      xocPayments: [existingXoc],
      vertexPayments: [existingVertex],
    });
    mockWriteFetch.mockImplementation(async () => ({
      ...initialReferral,
      ...committedValues,
    }));
    const res = createResponse();
    const request = {
      method: "POST",
      body: {
        referralId: "referral.account",
        packageType: "xoc",
        amount: 20,
        payoutId: "monthly-payout",
        paidOn: "2026-07-18T01:00:00.000Z",
        note: "Monthly payout",
      },
    };
    await handler(request, res);

    expect(res.statusCode).toBe(200);
    expect(committedValues.xocPayments).toEqual([
      existingXoc,
      expect.objectContaining({
        _key: "monthly-payout",
        _type: "paymentLogXoc",
        amount: 20,
        note: "Monthly payout",
      }),
    ]);
    expect(committedValues.vertexPayments).toEqual([existingVertex]);
    expect(committedValues).toMatchObject({
      paidXoc: 30,
      paidVertex: 5,
      paidTotal: 35,
      owedXoc: 70,
      owedVertex: 45,
      owedTotal: 115,
    });
    expect(res.body).toMatchObject({
      payments: { xoc: 30, vertex: 5, total: 35 },
      owed: { xoc: 70, vertex: 45, total: 115 },
    });
    expect(committedReceipt).toMatchObject({
      _type: "creatorPayout",
      referralId: "referral.account",
      packageType: "xoc",
      amount: 20,
      paymentEntry: committedValues.xocPayments[1],
    });
    const replay = createResponse();
    await handler(request, replay);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.logs).toEqual(res.body.logs);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockGetDocument).toHaveBeenCalledWith(committedReceipt._id);
  });

  test("rejects an existing payment key without changing either package array", async () => {
    const xocEntry = paymentEntry("shared-key", 12, "paymentLogXoc");
    const vertexEntry = paymentEntry("shared-key", 8, "paymentLogVertex");
    const otherVertex = paymentEntry("vertex-other", 4, "paymentLogVertex");
    const initialReferral = referral({
      xocPayments: [xocEntry],
      vertexPayments: [vertexEntry, otherVertex],
    });
    mockWriteFetch.mockResolvedValue(initialReferral);
    mockFetchReferralEarnings.mockResolvedValue({
      xoc: 40,
      vertex: 60,
      total: 100,
      byPackage: {},
    });
    const res = createResponse();

    await handler(
      {
        method: "POST",
        body: {
          referralId: "referral.account",
          packageType: "vertex",
          entryId: "shared-key",
          amount: 20,
          paidOn: "2026-07-18T02:00:00.000Z",
          note: "Corrected payout",
        },
      },
      res
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error:
        "This key belongs to an existing payment log. Use a new payoutId for a new transfer.",
    });
    expect(initialReferral.xocPayments).toEqual([xocEntry]);
    expect(initialReferral.vertexPayments).toEqual([vertexEntry, otherVertex]);
    expect(committedValues).toBeNull();
    expect(committedReceipt).toBeNull();
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test.each([
    [
      { packageType: "other", amount: 10 },
      'packageType must be "xoc" or "vertex"',
    ],
    [{ packageType: "xoc", amount: 0 }, "Amount must be a positive number"],
    [
      { packageType: "vertex", amount: 10, paidOn: "not-a-date" },
      "Invalid payment date supplied",
    ],
  ])("rejects invalid payment input before writing", async (input, error) => {
    const res = createResponse();

    await handler(
      {
        method: "POST",
        body: { referralId: "referral.account", ...input },
      },
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error });
    expect(mockWriteFetch).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
