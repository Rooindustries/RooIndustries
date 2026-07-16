const mockCreateClient = jest.fn(() => ({
  config: () => ({ projectId: "test-project", dataset: "production" }),
  fetch: jest.fn(),
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
});
