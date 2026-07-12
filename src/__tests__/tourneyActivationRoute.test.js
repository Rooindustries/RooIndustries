const mockInventory = jest.fn();
const mockApply = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status || 200,
      headers: init.headers || {},
      json: async () => body,
    }),
  },
}));
jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));
jest.mock("../server/tourney/activation", () => ({
  inventoryTourneyV4Activation: (...args) => mockInventory(...args),
  applyTourneyV4Activation: (...args) => mockApply(...args),
}));

const { POST } = require("../../app/api/admin/tourney-activation/route.js");
const originalSecret = process.env.CRON_SECRET;
const request = ({ secret = "activation-secret", payload = {} } = {}) => ({
  headers: {
    get: (name) => String(name).toLowerCase() === "authorization"
      ? `Bearer ${secret}`
      : "",
  },
  json: async () => payload,
});

describe("Tourney activation route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "activation-secret";
    mockInventory.mockResolvedValue({
      dryRun: true,
      inventoryHash: "a".repeat(64),
      counts: { linked: 4, unknown: 0 },
    });
    mockApply.mockResolvedValue({ applied: true });
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  test("hides the activation endpoint from unauthorized requests", async () => {
    const response = await POST(request({ secret: "wrong", payload: { action: "inventory" } }));
    expect(response.status).toBe(404);
    expect(mockInventory).not.toHaveBeenCalled();
  });

  test("returns a non-PII inventory gate", async () => {
    const response = await POST(request({ payload: { action: "inventory" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      dryRun: true,
      inventoryHash: "a".repeat(64),
      counts: { linked: 4, unknown: 0 },
    });
  });

  test("passes the exact inventory hash to activation apply", async () => {
    const inventoryHash = "b".repeat(64);
    const response = await POST(request({
      payload: { action: "apply", inventoryHash },
    }));
    expect(response.status).toBe(200);
    expect(mockApply).toHaveBeenCalledWith({ inventoryHash });
  });
});
