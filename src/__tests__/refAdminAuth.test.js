const createRes = () => ({
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

describe("referral admin authentication", () => {
  let requireAdminKey;

  beforeAll(() => {
    process.env.REF_ADMIN_KEY = "header-only-admin-secret";
    jest.isolateModules(() => {
      ({ requireAdminKey } = require("../server/api/ref/auth"));
    });
  });

  test("rejects credentials in query strings and request bodies", () => {
    const queryRes = createRes();
    expect(
      requireAdminKey(
        { headers: {}, query: { adminKey: "header-only-admin-secret" } },
        queryRes
      )
    ).toBe(false);
    expect(queryRes.statusCode).toBe(403);

    const bodyRes = createRes();
    expect(
      requireAdminKey(
        { headers: {}, body: { adminKey: "header-only-admin-secret" } },
        bodyRes
      )
    ).toBe(false);
    expect(bodyRes.statusCode).toBe(403);
  });

  test("accepts only the X-Admin-Key header", () => {
    expect(
      requireAdminKey(
        { headers: { "x-admin-key": "header-only-admin-secret" } },
        createRes()
      )
    ).toBe(true);
  });

  test("does not reuse CRON_SECRET as an admin key", () => {
    const previousAdminKey = process.env.REF_ADMIN_KEY;
    const previousCronSecret = process.env.CRON_SECRET;
    delete process.env.REF_ADMIN_KEY;
    process.env.CRON_SECRET = "cron-secret-must-not-authorize-admin";

    let isolatedRequireAdminKey;
    jest.isolateModules(() => {
      ({ requireAdminKey: isolatedRequireAdminKey } = require("../server/api/ref/auth"));
    });
    const response = createRes();
    expect(
      isolatedRequireAdminKey(
        { headers: { "x-admin-key": process.env.CRON_SECRET } },
        response
      )
    ).toBe(false);
    expect(response.statusCode).toBe(500);

    if (previousAdminKey === undefined) delete process.env.REF_ADMIN_KEY;
    else process.env.REF_ADMIN_KEY = previousAdminKey;
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
  });

  test("does not accept the retired REFERRAL_ADMIN_KEY alias", () => {
    const previousAdminKey = process.env.REF_ADMIN_KEY;
    const previousFallbackKey = process.env.REFERRAL_ADMIN_KEY;
    delete process.env.REF_ADMIN_KEY;
    process.env.REFERRAL_ADMIN_KEY = "retired-admin-key";

    let isolatedRequireAdminKey;
    jest.isolateModules(() => {
      ({ requireAdminKey: isolatedRequireAdminKey } = require("../server/api/ref/auth"));
    });
    const response = createRes();
    expect(
      isolatedRequireAdminKey(
        { headers: { "x-admin-key": process.env.REFERRAL_ADMIN_KEY } },
        response
      )
    ).toBe(false);
    expect(response.statusCode).toBe(500);

    if (previousAdminKey === undefined) delete process.env.REF_ADMIN_KEY;
    else process.env.REF_ADMIN_KEY = previousAdminKey;
    if (previousFallbackKey === undefined) delete process.env.REFERRAL_ADMIN_KEY;
    else process.env.REFERRAL_ADMIN_KEY = previousFallbackKey;
  });
});
