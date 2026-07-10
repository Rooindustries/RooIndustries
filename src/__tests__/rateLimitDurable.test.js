const {
  cleanupExpiredRateLimitBuckets,
  requireRateLimit,
} = require("../server/api/ref/rateLimit");

const createRes = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
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

const createDurableClient = () => {
  const buckets = new Map();
  let revision = 1;
  return {
    buckets,
    async fetch(query, params = {}) {
      if (String(query).includes("resetAt < $now")) {
        return [...buckets.values()]
          .filter((entry) => entry.resetAt < params.now)
          .map((entry) => entry._id);
      }
      const bucket = buckets.get(params.id);
      return bucket ? { ...bucket } : null;
    },
    async create(document) {
      if (buckets.has(document._id)) {
        throw Object.assign(new Error("conflict"), { statusCode: 409 });
      }
      const next = { ...document, _rev: `rev-${revision++}` };
      buckets.set(next._id, next);
      return { ...next };
    },
    patch(id) {
      const state = { revisionId: "", increment: 0 };
      const patch = {
        ifRevisionId(value) {
          state.revisionId = value;
          return patch;
        },
        inc({ count = 0 }) {
          state.increment += count;
          return patch;
        },
        async commit() {
          const current = buckets.get(id);
          if (!current || current._rev !== state.revisionId) {
            throw Object.assign(new Error("conflict"), { statusCode: 409 });
          }
          current.count += state.increment;
          current._rev = `rev-${revision++}`;
          return { ...current };
        },
      };
      return patch;
    },
    transaction() {
      const deletes = [];
      return {
        delete(id) {
          deletes.push(id);
          return this;
        },
        async commit() {
          deletes.forEach((id) => buckets.delete(id));
          return { deleted: deletes.length };
        },
      };
    },
  };
};

describe("durable rate limiting", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_HASH_SECRET = "rate-limit-test-secret-with-enough-entropy";
  });

  test("shares a HMAC-keyed bucket and returns Retry-After at the limit", async () => {
    const client = createDurableClient();
    const options = {
      key: "payment-start:203.0.113.10:client@example.com",
      max: 2,
      windowMs: 60_000,
      now: Date.parse("2026-07-10T00:00:30.000Z"),
      client,
    };

    expect(await requireRateLimit(createRes(), options)).toBe(true);
    expect(await requireRateLimit(createRes(), options)).toBe(true);
    const blocked = createRes();
    expect(await requireRateLimit(blocked, options)).toBe(false);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("30");
    expect([...client.buckets.keys()][0]).toMatch(/^rateLimitBucket\.[a-f0-9]{64}$/);
    expect([...client.buckets.keys()][0]).not.toContain("client@example.com");
  });

  test("fails closed when durable storage is unavailable", async () => {
    const res = createRes();
    const client = {
      fetch: jest.fn().mockRejectedValue(new Error("storage offline")),
    };
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await requireRateLimit(res, {
        key: "ref-login:203.0.113.10",
        client,
      })
    ).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    errorSpy.mockRestore();
  });

  test("reconciliation cleanup removes expired buckets only", async () => {
    const client = createDurableClient();
    client.buckets.set("rateLimitBucket.expired", {
      _id: "rateLimitBucket.expired",
      resetAt: "2026-07-09T00:00:00.000Z",
    });
    client.buckets.set("rateLimitBucket.active", {
      _id: "rateLimitBucket.active",
      resetAt: "2026-07-11T00:00:00.000Z",
    });

    await expect(
      cleanupExpiredRateLimitBuckets({
        client,
        now: "2026-07-10T00:00:00.000Z",
      })
    ).resolves.toBe(1);
    expect([...client.buckets.keys()]).toEqual(["rateLimitBucket.active"]);
  });
});
