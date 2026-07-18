const mockRequireReferralSession = jest.fn();

jest.mock("../server/api/ref/auth.js", () => ({
  requireReferralSession: (...args) => mockRequireReferralSession(...args),
}));

const handlerModule = require("../server/api/ref/sessionStatus.js");
const handler = handlerModule.default || handlerModule;

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

describe("referral session status", () => {
  beforeEach(() => mockRequireReferralSession.mockReset());

  test.each([
    [null, false],
    [{ referralId: "referral.creator" }, true],
  ])("returns a quiet 200 probe response", async (session, authenticated) => {
    mockRequireReferralSession.mockResolvedValue(session);
    const response = createResponse();

    await handler({ method: "GET", headers: {} }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, authenticated });
    expect(mockRequireReferralSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: expect.any(Function),
        json: expect.any(Function),
      })
    );
  });

  test("rejects non-GET probes", async () => {
    const response = createResponse();

    await handler({ method: "POST", headers: {} }, response);

    expect(response.statusCode).toBe(405);
    expect(mockRequireReferralSession).not.toHaveBeenCalled();
  });
});
