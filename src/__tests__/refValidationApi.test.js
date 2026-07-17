const mockFetch = jest.fn();
const mockCreateClient = jest.fn(() => ({
  config: () => ({ projectId: "test-project", dataset: "production" }),
  fetch: (...args) => mockFetch(...args),
}));
const previousDataPrimary = process.env.DATA_PRIMARY_BACKEND;
const previousCommercePrimary = process.env.COMMERCE_PRIMARY_BACKEND;

jest.mock("@sanity/client", () => ({
  createClient: (...args) => mockCreateClient(...args),
}));

beforeAll(() => {
  process.env.DATA_PRIMARY_BACKEND = "sanity";
  process.env.COMMERCE_PRIMARY_BACKEND = "sanity";
});

afterAll(() => {
  if (previousDataPrimary === undefined) delete process.env.DATA_PRIMARY_BACKEND;
  else process.env.DATA_PRIMARY_BACKEND = previousDataPrimary;
  if (previousCommercePrimary === undefined) {
    delete process.env.COMMERCE_PRIMARY_BACKEND;
  } else {
    process.env.COMMERCE_PRIMARY_BACKEND = previousCommercePrimary;
  }
});

const createRes = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  setHeader(name, value) {
    this.headers[name] = value;
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

describe("referral validation API", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    globalThis.__rooRateLimitBuckets?.clear?.();
  });

  test("rejects POST instead of accepting query parameters through an unsupported method", async () => {
    const module = require("../server/api/ref/validateReferral");
    const handler = module.default || module;
    const res = createRes();

    await handler(
      {
        method: "POST",
        query: { code: "creator-code" },
        body: { code: "different-code" },
      },
      res
    );

    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET");
    expect(res.body).toEqual({ ok: false, error: "Method not allowed" });
  });

  test("returns only the public checkout projection", async () => {
    mockFetch.mockResolvedValue({
      _id: "referral.creator",
      code: "creator",
      name: "Private Creator Name",
      currentCommissionPercent: 25,
      currentDiscountPercent: 150,
      isFirstTime: false,
    });
    const module = require("../server/api/ref/validateReferral");
    const handler = module.default || module;
    const res = createRes();

    await handler(
      {
        method: "GET",
        query: { code: "CREATOR" },
        headers: { "x-forwarded-for": "203.0.113.41" },
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      active: true,
      eligible: true,
      referral: {
        code: "creator",
        currentDiscountPercent: 100,
      },
    });
    const query = String(mockFetch.mock.calls[0][0]);
    expect(query).not.toMatch(
      /\b(?:_id|name|currentCommissionPercent|isFirstTime)\b/
    );
  });
});
