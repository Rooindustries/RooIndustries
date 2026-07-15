const buildJsonRequest = (url, { method = "GET", body, headers = {} } = {}) =>
  new Request(url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const originalResponseJson = Response.json;

const createLegacyResponse = () => {
  const headers = {};
  const state = { status: 200, body: null, headers };
  const response = {
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
      return response;
    },
    status(status) {
      state.status = status;
      return response;
    },
    json(body) {
      state.body = body;
      return body;
    },
  };
  return { response, state };
};

const buildEchoHandler = (name) =>
  jest.fn((req, res) =>
    res.status(200).json({
      ok: true,
      route: name,
      method: req.method,
      body: req.body,
      query: req.query,
      headers: req.headers,
      rawBody: req.rawBody || "",
    })
  );

const loadPaymentActionRoute = async (handlerOverrides = {}) => {
  jest.resetModules();
  const recordCommerceResponseMetric = jest.fn(async () => {});

  const handlers = {
    cancel: handlerOverrides.cancel || buildEchoHandler("cancel"),
    finalize: handlerOverrides.finalize || buildEchoHandler("finalize"),
    providers: handlerOverrides.providers || buildEchoHandler("providers"),
    quote: handlerOverrides.quote || buildEchoHandler("quote"),
    reconcile: handlerOverrides.reconcile || buildEchoHandler("reconcile"),
    start: handlerOverrides.start || buildEchoHandler("start"),
    status: handlerOverrides.status || buildEchoHandler("status"),
  };

  jest.doMock("../server/api/payment/cancel.js", () => ({
    __esModule: true,
    default: handlers.cancel,
  }));

  jest.doMock("../server/api/payment/finalize.js", () => ({
    __esModule: true,
    default: handlers.finalize,
  }));
  jest.doMock("../server/api/payment/providers.js", () => ({
    __esModule: true,
    default: handlers.providers,
  }));
  jest.doMock("../server/api/payment/quote.js", () => ({
    __esModule: true,
    default: handlers.quote,
  }));
  jest.doMock("../server/api/payment/reconcile.js", () => ({
    __esModule: true,
    default: handlers.reconcile,
  }));
  jest.doMock("../server/api/payment/start.js", () => ({
    __esModule: true,
    default: handlers.start,
  }));
  jest.doMock("../server/api/payment/status.js", () => ({
    __esModule: true,
    default: handlers.status,
  }));
  jest.doMock("next/server", () => ({
    after: (callback) => callback(),
  }));
  jest.doMock("../server/supabase/commerceMetrics.js", () => ({
    recordCommerceResponseMetric,
  }));

  const route = require("../../app/api/payment/[action]/route.js");
  return {
    route,
    handlers,
    recordCommerceResponseMetric,
  };
};

const loadWebhookRoute = async ({ provider }) => {
  jest.resetModules();
  const handler = buildEchoHandler(provider);

  if (provider === "paypal") {
    jest.doMock("../server/api/payment/webhookPayPal.js", () => ({
      __esModule: true,
      default: handler,
    }));
  } else {
    jest.doMock("../server/api/payment/webhookRazorpay.js", () => ({
      __esModule: true,
      default: handler,
    }));
  }

  const route = require(
    provider === "paypal"
      ? "../../app/api/payment/webhook/paypal/route.js"
      : "../../app/api/payment/webhook/razorpay/route.js"
  );

  return {
    route,
    handler,
  };
};

describe("payment app route adapters", () => {
  beforeAll(() => {
    if (typeof Response.json !== "function") {
      Response.json = (payload, init = {}) =>
        new Response(JSON.stringify(payload), {
          ...init,
          headers: {
            "content-type": "application/json; charset=utf-8",
            ...(init.headers || {}),
          },
        });
    }
  });

  afterAll(() => {
    Response.json = originalResponseJson;
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("allows the shared reconciliation scheduler its full bounded runtime", async () => {
    const { route } = await loadPaymentActionRoute();
    expect(route.maxDuration).toBe(300);
  });

  test("start forwards the canonical payment body through the App Router adapter", async () => {
    const { route, handlers, recordCommerceResponseMetric } =
      await loadPaymentActionRoute();
    const request = buildJsonRequest("https://example.com/api/payment/start", {
      method: "POST",
      body: {
        provider: "paypal",
        bookingPayload: {
          packageTitle: "Performance Vertex Overhaul",
          email: "client@example.com",
        },
      },
    });

    const response = await route.POST(request, {
      params: Promise.resolve({ action: "start" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      route: "start",
      method: "POST",
      body: {
        provider: "paypal",
        bookingPayload: {
          packageTitle: "Performance Vertex Overhaul",
          email: "client@example.com",
        },
      },
    });
    expect(handlers.start).toHaveBeenCalledTimes(1);
    expect(recordCommerceResponseMetric).toHaveBeenCalledWith(expect.objectContaining({
      route: "payment/start",
      statusCode: 200,
    }));
  });

  test("accepts the canonical production origin behind Vercel's internal request URL", async () => {
    const { route, handlers } = await loadPaymentActionRoute();
    const request = buildJsonRequest(
      "https://rooindustries-git-main.vercel.app/api/payment/start",
      {
        method: "POST",
        headers: {
          origin: "https://www.rooindustries.com",
          "x-forwarded-host": "www.rooindustries.com",
          "x-forwarded-proto": "https",
        },
        body: { provider: "paypal" },
      }
    );
    const response = await route.POST(request, {
      params: Promise.resolve({ action: "start" }),
    });
    expect(response.status).toBe(200);
    expect(handlers.start).toHaveBeenCalledTimes(1);
  });

  test("finalize strips the public source field before the legacy handler runs", async () => {
    const { route, handlers } = await loadPaymentActionRoute();
    const request = buildJsonRequest("https://example.com/api/payment/finalize", {
      method: "POST",
      headers: { authorization: "Bearer payment_access_token" },
      body: {
        paymentAccessToken: "payment_access_token",
        source: "webhook",
        providerData: {
          paypalOrderId: "paypal_order_1",
        },
      },
    });

    const response = await route.POST(request, {
      params: Promise.resolve({ action: "finalize" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.body).toEqual({
      paymentAccessToken: "payment_access_token",
      providerData: {
        paypalOrderId: "paypal_order_1",
      },
    });
    expect(body.body.source).toBeUndefined();
    expect(body.headers.authorization).toBe("Bearer payment_access_token");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(handlers.finalize).toHaveBeenCalledTimes(1);
  });

  test("status forwards GET query params through the adapter", async () => {
    const { route, handlers } = await loadPaymentActionRoute();
    const request = buildJsonRequest(
      "https://example.com/api/payment/status?paymentAccessToken=test_token",
      { method: "GET" }
    );

    const response = await route.GET(request, {
      params: Promise.resolve({ action: "status" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      route: "status",
      method: "GET",
      query: {
        paymentAccessToken: "test_token",
      },
    });
    expect(handlers.status).toHaveBeenCalledTimes(1);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("status accepts POST with a bearer token and no URL credential", async () => {
    const { route, handlers } = await loadPaymentActionRoute();
    const request = buildJsonRequest("https://example.com/api/payment/status", {
      method: "POST",
      body: {},
      headers: { authorization: "Bearer payment_access_token" },
    });

    const response = await route.POST(request, {
      params: Promise.resolve({ action: "status" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      route: "status",
      method: "POST",
      query: {},
      headers: { authorization: "Bearer payment_access_token" },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(handlers.status).toHaveBeenCalledTimes(1);
  });

  test("reconcile accepts authenticated GET requests from Vercel Cron", async () => {
    const { route, handlers, recordCommerceResponseMetric } =
      await loadPaymentActionRoute();
    const request = buildJsonRequest("https://example.com/api/payment/reconcile", {
      method: "GET",
      headers: { authorization: "Bearer cron-secret" },
    });

    const response = await route.GET(request, {
      params: Promise.resolve({ action: "reconcile" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      route: "reconcile",
      method: "GET",
      headers: { authorization: "Bearer cron-secret" },
    });
    expect(handlers.reconcile).toHaveBeenCalledTimes(1);
    expect(recordCommerceResponseMetric).not.toHaveBeenCalled();
  });

  test("unknown payment actions return a 404 JSON response", async () => {
    const { route } = await loadPaymentActionRoute();
    const request = buildJsonRequest("https://example.com/api/payment/not-real", {
      method: "POST",
      body: {},
    });

    const response = await route.POST(request, {
      params: Promise.resolve({ action: "not-real" }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      ok: false,
      error: "Not found",
    });
  });

  test.each([
    {
      name: "malformed JSON",
      request: () =>
        new Request("https://example.com/api/payment/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"provider":',
        }),
      status: 400,
      code: "malformed_json",
    },
    {
      name: "duplicate JSON properties",
      request: () =>
        new Request("https://example.com/api/payment/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"provider":"paypal","provider":"razorpay"}',
        }),
      status: 400,
      code: "invalid_request",
    },
    {
      name: "unsupported content types",
      request: () =>
        new Request("https://example.com/api/payment/start", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: '{"provider":"paypal"}',
        }),
      status: 415,
      code: "unsupported_media_type",
    },
    {
      name: "cross-origin mutation requests",
      request: () =>
        new Request("https://example.com/api/payment/start", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://attacker.example",
          },
          body: "{}",
        }),
      status: 403,
      code: "cross_origin_rejected",
    },
    {
      name: "oversized payloads",
      request: () =>
        new Request("https://example.com/api/payment/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "x".repeat(130 * 1024) }),
        }),
      status: 413,
      code: "payload_too_large",
    },
  ])("rejects $name before invoking payment code", async ({ request, status, code }) => {
    const { route, handlers } = await loadPaymentActionRoute();
    const response = await route.POST(request(), {
      params: Promise.resolve({ action: "start" }),
    });
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code });
    expect(handlers.start).not.toHaveBeenCalled();
  });

  test("rejects duplicate query parameters before invoking payment code", async () => {
    const { route, handlers } = await loadPaymentActionRoute();
    const response = await route.GET(
      new Request("https://example.com/api/payment/status?payment=a&payment=b"),
      { params: Promise.resolve({ action: "status" }) }
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "duplicate_query",
    });
    expect(handlers.status).not.toHaveBeenCalled();
  });

  test("rejects deeply nested JSON before invoking payment code", async () => {
    const { route, handlers } = await loadPaymentActionRoute();
    let body = { value: true };
    for (let depth = 0; depth < 24; depth += 1) body = { child: body };
    const response = await route.POST(
      buildJsonRequest("https://example.com/api/payment/start", {
        method: "POST",
        body,
      }),
      { params: Promise.resolve({ action: "start" }) }
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "payload_too_complex",
    });
    expect(handlers.start).not.toHaveBeenCalled();
  });
});

describe("payment webhook route adapters", () => {
  beforeAll(() => {
    if (typeof Response.json !== "function") {
      Response.json = (payload, init = {}) =>
        new Response(JSON.stringify(payload), {
          ...init,
          headers: {
            "content-type": "application/json; charset=utf-8",
            ...(init.headers || {}),
          },
        });
    }
  });

  afterAll(() => {
    Response.json = originalResponseJson;
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("PayPal webhook routes preserve the JSON rawBody for signature verification", async () => {
    const { route, handler } = await loadWebhookRoute({ provider: "paypal" });
    const payload = {
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "capture_1",
      },
    };
    const rawBody = JSON.stringify(payload);
    const request = new Request("https://example.com/api/payment/webhook/paypal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "paypal-transmission-id": "tx-1",
      },
      body: rawBody,
    });

    const response = await route.POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      route: "paypal",
      body: payload,
      rawBody,
      headers: {
        "content-type": "application/json",
        "paypal-transmission-id": "tx-1",
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("Razorpay webhook routes preserve the JSON rawBody for signature verification", async () => {
    const { route, handler } = await loadWebhookRoute({ provider: "razorpay" });
    const payload = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_1",
            order_id: "order_1",
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const request = new Request(
      "https://example.com/api/payment/webhook/razorpay",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-razorpay-signature": "signature_1",
        },
        body: rawBody,
      }
    );

    const response = await route.POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      route: "razorpay",
      body: payload,
      rawBody,
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": "signature_1",
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("payment bearer-token handlers", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.PAYMENT_LEGACY_COMPLETION_UNTIL;
    delete process.env.PAYMENT_LEGACY_STATUS_GET_UNTIL;
  });

  test("finalize ignores an expired legacy body token and forwards only bearer auth", async () => {
    jest.dontMock("../server/api/payment/finalize.js");
    const finalizePaymentSession = jest.fn().mockResolvedValue({
      httpStatus: 401,
      body: { ok: false },
    });
    jest.doMock("../server/api/payment/flow.js", () => ({
      __esModule: true,
      finalizePaymentSession,
    }));
    process.env.PAYMENT_LEGACY_COMPLETION_UNTIL = "2000-01-01T00:00:00.000Z";
    const handler = require("../server/api/payment/finalize.js").default;
    const { response, state } = createLegacyResponse();

    await handler(
      {
        method: "POST",
        headers: {},
        body: { paymentAccessToken: "legacy_url_or_body_token" },
      },
      response
    );

    expect(finalizePaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentAccessToken: "",
        allowLegacyTokenFallback: false,
      })
    );
    expect(state.headers["cache-control"]).toBe("private, no-store");
  });

  test("status POST forwards bearer auth and disables query fallback", async () => {
    jest.dontMock("../server/api/payment/status.js");
    const getPaymentStatus = jest.fn().mockResolvedValue({
      httpStatus: 200,
      body: { ok: true },
    });
    jest.doMock("../server/api/payment/flow.js", () => ({
      __esModule: true,
      getPaymentStatus,
    }));
    const handler = require("../server/api/payment/status.js").default;
    const { response, state } = createLegacyResponse();

    await handler(
      {
        method: "POST",
        headers: { authorization: "Bearer secure_payment_token" },
        body: {},
        query: {},
      },
      response
    );

    expect(getPaymentStatus).toHaveBeenCalledWith({
      query: {},
      paymentAccessToken: "secure_payment_token",
      allowLegacyTokenFallback: false,
    });
    expect(state.headers["cache-control"]).toBe("private, no-store");
  });

  test("legacy GET status expires completely after its compatibility deadline", async () => {
    jest.dontMock("../server/api/payment/status.js");
    const getPaymentStatus = jest.fn();
    jest.doMock("../server/api/payment/flow.js", () => ({
      __esModule: true,
      getPaymentStatus,
    }));
    process.env.PAYMENT_LEGACY_STATUS_GET_UNTIL = "2000-01-01T00:00:00.000Z";
    const handler = require("../server/api/payment/status.js").default;
    const { response, state } = createLegacyResponse();

    await handler(
      {
        method: "GET",
        headers: { authorization: "Bearer old_payment_token" },
        query: { paymentAccessToken: "old_payment_token" },
      },
      response
    );

    expect(state.status).toBe(410);
    expect(state.body.code).toBe("legacy_payment_status_expired");
    expect(getPaymentStatus).not.toHaveBeenCalled();
  });

  test("legacy GET status accepts a query token only before its deadline", async () => {
    jest.dontMock("../server/api/payment/status.js");
    const getPaymentStatus = jest.fn().mockResolvedValue({
      httpStatus: 200,
      body: { ok: true },
    });
    jest.doMock("../server/api/payment/flow.js", () => ({
      __esModule: true,
      getPaymentStatus,
    }));
    process.env.PAYMENT_LEGACY_STATUS_GET_UNTIL = "2099-01-01T00:00:00.000Z";
    const handler = require("../server/api/payment/status.js").default;
    const { response } = createLegacyResponse();

    await handler(
      {
        method: "GET",
        headers: {},
        query: { paymentAccessToken: "legacy_payment_token" },
      },
      response
    );

    expect(getPaymentStatus).toHaveBeenCalledWith({
      query: { paymentAccessToken: "legacy_payment_token" },
      paymentAccessToken: "legacy_payment_token",
      allowLegacyTokenFallback: false,
    });
  });
});
