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

  beforeEach(() => {
    jest.clearAllMocks();
    committedValues = null;
    mockRequireAdminKey.mockReturnValue(true);
    mockReadFetch.mockResolvedValue([]);
    mockFetchReferralEarnings.mockResolvedValue({
      xoc: 100,
      vertex: 50,
      total: 150,
      byPackage: {},
    });
    mockPatch.mockImplementation(() => {
      const values = {};
      const patch = {
        ifRevisionId: () => patch,
        set(nextValues) {
          Object.assign(values, nextValues);
          return patch;
        },
        async commit() {
          committedValues = values;
          return { _rev: "revision-two" };
        },
      };
      return patch;
    });
  });

  test("appends a new entry and recomputes paid and owed totals", async () => {
    const existingXoc = paymentEntry("xoc-existing", 10, "paymentLogXoc");
    const existingVertex = paymentEntry(
      "vertex-existing",
      5,
      "paymentLogVertex"
    );
    mockWriteFetch.mockResolvedValue(
      referral({
        xocPayments: [existingXoc],
        vertexPayments: [existingVertex],
      })
    );
    const res = createResponse();

    await handler(
      {
        method: "POST",
        body: {
          referralId: "referral.account",
          packageType: "xoc",
          amount: 20,
          paidOn: "2026-07-18T01:00:00.000Z",
          note: "Monthly payout",
        },
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(committedValues.xocPayments).toEqual([
      existingXoc,
      expect.objectContaining({
        _key: expect.any(String),
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
  });

  test("upserts only the matching package array when keys overlap", async () => {
    const xocEntry = paymentEntry("shared-key", 12, "paymentLogXoc");
    const vertexEntry = paymentEntry("shared-key", 8, "paymentLogVertex");
    const otherVertex = paymentEntry("vertex-other", 4, "paymentLogVertex");
    mockWriteFetch.mockResolvedValue(
      referral({
        xocPayments: [xocEntry],
        vertexPayments: [vertexEntry, otherVertex],
      })
    );
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

    expect(res.statusCode).toBe(200);
    expect(committedValues.xocPayments).toEqual([xocEntry]);
    expect(committedValues.vertexPayments).toEqual([
      expect.objectContaining({
        _key: "shared-key",
        _type: "paymentLogVertex",
        amount: 20,
        note: "Corrected payout",
      }),
      otherVertex,
    ]);
    expect(committedValues).toMatchObject({
      paidXoc: 12,
      paidVertex: 24,
      paidTotal: 36,
      owedXoc: 28,
      owedVertex: 36,
      owedTotal: 64,
    });
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
