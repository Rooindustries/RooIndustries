const mockFetch = jest.fn();
const mockCommit = jest.fn();
const mockSet = jest.fn();
const mockPatch = jest.fn();
const mockRequireReferralSession = jest.fn();
const mockAssertCommerceWriteAllowed = jest.fn();

jest.mock("../server/data/documentClient", () => ({
  createDataClient: () => ({
    fetch: (...args) => mockFetch(...args),
    patch: (...args) => mockPatch(...args),
  }),
}));
jest.mock("../server/api/ref/auth", () => ({
  requireReferralSession: (...args) => mockRequireReferralSession(...args),
}));
jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));
jest.mock("../server/supabase/commerceControl", () => ({
  assertCommerceWriteAllowed: (...args) =>
    mockAssertCommerceWriteAllowed(...args),
}));

const updateSplit = require("../server/api/ref/updateSplit").default;

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

describe("referral split updates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireReferralSession.mockResolvedValue({ referralId: "referral.creator" });
    mockAssertCommerceWriteAllowed.mockResolvedValue({
      primaryBackend: "supabase",
      generation: 1,
      startsPaused: false,
    });
    const patch = {
      set: (...args) => {
        mockSet(...args);
        return patch;
      },
      commit: (...args) => mockCommit(...args),
    };
    mockPatch.mockReturnValue(patch);
    mockCommit.mockResolvedValue({ _id: "referral.creator" });
  });

  test("blocks a creator who has not met the referral requirement", async () => {
    mockFetch.mockResolvedValue({
      maxCommissionPercent: 20,
      successfulReferrals: 4,
      bypassUnlock: false,
      isFirstTime: true,
    });
    const response = createResponse();
    await updateSplit({
      method: "POST",
      body: { commissionPercent: 10, discountPercent: 10 },
    }, response);
    expect(response.statusCode).toBe(403);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  test("allows a bypassed creator and stores exact two-decimal values", async () => {
    mockFetch.mockResolvedValue({
      maxCommissionPercent: 20,
      successfulReferrals: 0,
      bypassUnlock: true,
      isFirstTime: true,
    });
    const response = createResponse();
    await updateSplit({
      method: "POST",
      body: { commissionPercent: "9.25", discountPercent: "10.75" },
    }, response);
    expect(response.statusCode).toBe(200);
    expect(mockSet).toHaveBeenNthCalledWith(1, {
      currentCommissionPercent: 9.25,
      currentDiscountPercent: 10.75,
    });
    expect(mockSet).toHaveBeenNthCalledWith(2, { isFirstTime: false });
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });

  test("rejects percentage precision that cannot map exactly to basis points", async () => {
    const response = createResponse();
    await updateSplit({
      method: "POST",
      body: { commissionPercent: "10.001", discountPercent: "0" },
    }, response);
    expect(response.statusCode).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  test("does not fetch or patch creator terms while commerce is paused", async () => {
    mockAssertCommerceWriteAllowed.mockRejectedValueOnce(
      Object.assign(new Error("paused"), {
        code: "COMMERCE_STARTS_PAUSED",
        statusCode: 503,
      })
    );
    const response = createResponse();
    await updateSplit({
      method: "POST",
      body: { commissionPercent: "10", discountPercent: "10" },
    }, response);
    expect(response.statusCode).toBe(503);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });
});
