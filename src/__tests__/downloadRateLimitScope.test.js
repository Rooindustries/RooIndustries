const mockValidateDownloadAccess = jest.fn(async () => ({
  status: 404,
  body: { ok: false, error: "Not found" },
}));

jest.mock("@/src/server/downloads/downloadAccess", () => ({
  createDownloadDataClient: () => ({}),
  validateDownloadAccess: (...args) => mockValidateDownloadAccess(...args),
}));

const requestFor = (attempt) =>
  new Request("http://localhost/api/downloads/validate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.77",
    },
    body: JSON.stringify({
      slug: `download-${attempt}`,
      orderId: `order-${attempt}`,
      email: `customer-${attempt}@example.com`,
    }),
  });

describe("download lookup rate-limit scope", () => {
  beforeEach(() => {
    globalThis.__rooRateLimitBuckets?.clear?.();
    mockValidateDownloadAccess.mockClear();
  });

  test("varying all lookup fields cannot bypass the 12-request IP limit", async () => {
    const route = require("../../app/api/downloads/validate/route.js");

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const response = await route.POST(requestFor(attempt));
      expect(response.status).toBe(404);
    }

    const blocked = await route.POST(requestFor(13));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(mockValidateDownloadAccess).toHaveBeenCalledTimes(12);
  });
});
