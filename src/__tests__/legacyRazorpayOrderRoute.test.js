describe("legacy Razorpay order endpoint", () => {
  test("cannot create a fresh provider order during the completion compatibility window", async () => {
    const originalDeadline = process.env.PAYMENT_LEGACY_COMPLETION_UNTIL;
    process.env.PAYMENT_LEGACY_COMPLETION_UNTIL = "2099-01-01T00:00:00.000Z";
    const originalFetch = global.fetch;
    global.fetch = jest.fn();

    try {
      const module = require("../server/api/razorpay/createOrder");
      const handler = module.default || module;
      const state = { status: 200, body: null };
      const res = {
        setHeader: jest.fn(),
        status(code) {
          state.status = code;
          return this;
        },
        json(body) {
          state.body = body;
          return this;
        },
      };

      await handler(
        {
          method: "POST",
          body: {
            notes: { packageTitle: "Performance Vertex Max" },
          },
        },
        res
      );

      expect(state.status).toBe(410);
      expect(state.body).toMatchObject({
        ok: false,
        code: "legacy_order_creation_retired",
      });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
      if (originalDeadline === undefined) {
        delete process.env.PAYMENT_LEGACY_COMPLETION_UNTIL;
      } else {
        process.env.PAYMENT_LEGACY_COMPLETION_UNTIL = originalDeadline;
      }
    }
  });

  test("legacy completion verification uses a trimmed secret and constant-time signature check", async () => {
    const crypto = require("crypto");
    const previous = {
      deadline: process.env.PAYMENT_LEGACY_COMPLETION_UNTIL,
      keyId: process.env.RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
    };
    process.env.PAYMENT_LEGACY_COMPLETION_UNTIL = "2099-01-01T00:00:00.000Z";
    process.env.RAZORPAY_KEY_ID = "rzp_test_legacy_verification";
    process.env.RAZORPAY_KEY_SECRET = "  legacy-secret  ";

    const responseFor = () => {
      const state = { status: 200, body: null };
      return {
        state,
        res: {
          setHeader: jest.fn(),
          status(code) {
            state.status = code;
            return this;
          },
          json(body) {
            state.body = body;
            return this;
          },
        },
      };
    };

    try {
      const module = require("../server/api/razorpay/verify");
      const handler = module.default || module;
      const body = "order_test|payment_test";
      const signature = crypto
        .createHmac("sha256", "legacy-secret")
        .update(body)
        .digest("hex");
      const valid = responseFor();
      await handler(
        {
          method: "POST",
          body: {
            razorpay_order_id: "order_test",
            razorpay_payment_id: "payment_test",
            razorpay_signature: signature,
          },
        },
        valid.res
      );
      expect(valid.state.status).toBe(200);

      const invalid = responseFor();
      await handler(
        {
          method: "POST",
          body: {
            razorpay_order_id: "order_test",
            razorpay_payment_id: "payment_test",
            razorpay_signature: "short",
          },
        },
        invalid.res
      );
      expect(invalid.state.status).toBe(400);
      expect(invalid.state.body).toMatchObject({ ok: false, message: "Invalid signature" });
    } finally {
      for (const [key, value] of Object.entries({
        PAYMENT_LEGACY_COMPLETION_UNTIL: previous.deadline,
        RAZORPAY_KEY_ID: previous.keyId,
        RAZORPAY_KEY_SECRET: previous.keySecret,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
