const mockRpc = jest.fn();
const mockCreateRefWriteClient = jest.fn();

jest.mock("../server/supabase/adminClient.js", () => ({
  createSupabaseAdminClient: () => ({ rpc: mockRpc }),
}));

jest.mock("../server/api/ref/sanity.js", () => ({
  createRefWriteClient: (...args) => mockCreateRefWriteClient(...args),
}));

const { requireRateLimit } = require("../server/api/ref/rateLimit.js");

const createRes = () => ({
  statusCode: 200,
  headers: {},
  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
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

describe("download validation rate-limit authority", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "production";
    process.env.DATA_PRIMARY_BACKEND = "sanity";
    process.env.COMMERCE_PRIMARY_BACKEND = "supabase";
    process.env.COMMERCE_CUTOVER_ENABLED = "1";
    process.env.SANITY_REVERSE_MIRROR_WRITES = "1";
    process.env.RATE_LIMIT_HASH_SECRET = "download-rate-limit-test-secret";
    mockRpc.mockResolvedValue({ data: { allowed: true }, error: null });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.DATA_PRIMARY_BACKEND;
    delete process.env.COMMERCE_PRIMARY_BACKEND;
    delete process.env.COMMERCE_CUTOVER_ENABLED;
    delete process.env.SANITY_REVERSE_MIRROR_WRITES;
    delete process.env.RATE_LIMIT_HASH_SECRET;
  });

  test("uses Supabase without loading the global Sanity limiter", async () => {
    await expect(
      requireRateLimit(createRes(), {
        key: "download-validate:203.0.113.10",
        max: 12,
        now: Date.parse("2026-07-15T00:00:00.000Z"),
      })
    ).resolves.toBe(true);
    expect(mockRpc).toHaveBeenCalledWith(
      "roo_consume_rate_limit",
      expect.objectContaining({
        p_bucket_key_hmac: expect.stringMatching(/^[a-f0-9]{64}$/),
        p_max: 12,
      })
    );
    expect(mockCreateRefWriteClient).not.toHaveBeenCalled();
  });
});
