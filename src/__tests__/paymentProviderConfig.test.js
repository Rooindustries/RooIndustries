describe("payment provider runtime policy", () => {
  const ORIGINAL_ENV = { ...process.env };

  const loadProviderConfig = () => {
    jest.resetModules();
    return require("../server/api/payment/providerConfig.js");
  };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.VERCEL_ENV;
    delete process.env.NEXT_PUBLIC_VERCEL_ENV;
    delete process.env.REACT_APP_VERCEL_ENV;
    delete process.env.NODE_ENV;
    delete process.env.ENABLE_PREVIEW_PAYMENTS;
    delete process.env.ALLOW_PREVIEW_PAYMENTS;
    delete process.env.ALLOW_LIVE_PAYMENTS_IN_DEVELOPMENT;
    delete process.env.ALLOW_LIVE_PAYMENTS_IN_PREVIEW;
    delete process.env.PAYPAL_ENV;
    delete process.env.NEXT_PUBLIC_PAYPAL_ENV;
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.REACT_APP_PAYPAL_CLIENT_ID;
    delete process.env.REACT_APP_PAYPAL_CLIENT_SECRET;
    delete process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test("normalizes runtime strings and booleans without treating preview like production", () => {
    const { normalizeRuntimePolicy } = loadProviderConfig();

    expect(normalizeRuntimePolicy("preview")).toEqual({
      runtime: "preview",
      isProdLike: false,
      isPreview: true,
      previewPaymentsEnabled: false,
      livePaymentsEnabled: false,
    });
    expect(normalizeRuntimePolicy("development")).toEqual({
      runtime: "development",
      isProdLike: false,
      isPreview: false,
      previewPaymentsEnabled: false,
      livePaymentsEnabled: false,
    });
    expect(normalizeRuntimePolicy("not-real")).toEqual({
      runtime: "development",
      isProdLike: false,
      isPreview: false,
      previewPaymentsEnabled: false,
      livePaymentsEnabled: false,
    });
    expect(normalizeRuntimePolicy(true)).toEqual({
      runtime: "production",
      isProdLike: true,
      isPreview: false,
      previewPaymentsEnabled: false,
      livePaymentsEnabled: true,
    });
  });

  test("development disables live providers by default", () => {
    process.env.VERCEL_ENV = "development";
    process.env.PAYPAL_ENV = "live";
    process.env.RAZORPAY_KEY_ID = "rzp_live_dev";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    process.env.PAYPAL_CLIENT_ID = "paypal-live-client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal-live-secret";

    const { resolvePaymentProviders } = loadProviderConfig();
    const providers = resolvePaymentProviders();

    expect(providers.runtime).toBe("development");
    expect(providers.livePaymentsEnabled).toBe(false);
    expect(providers.razorpay).toEqual({
      enabled: false,
      mode: "live",
    });
    expect(providers.paypal).toEqual({
      enabled: false,
      mode: "live",
      clientId: "",
    });
  });

  test("development can opt into live providers explicitly", () => {
    process.env.VERCEL_ENV = "development";
    process.env.ALLOW_LIVE_PAYMENTS_IN_DEVELOPMENT = "1";
    process.env.RAZORPAY_KEY_ID = "rzp_live_dev";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    process.env.PAYPAL_CLIENT_ID = "paypal-live-client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal-live-secret";

    const { resolvePaymentProviders } = loadProviderConfig();
    const providers = resolvePaymentProviders();

    expect(providers.runtime).toBe("development");
    expect(providers.livePaymentsEnabled).toBe(true);
    expect(providers.razorpay).toEqual({
      enabled: true,
      mode: "live",
    });
    expect(providers.paypal).toEqual({
      enabled: true,
      mode: "live",
      clientId: "paypal-live-client",
    });
  });

  test("preview disables payment providers by default", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.RAZORPAY_KEY_ID = "rzp_test_preview";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    process.env.PAYPAL_CLIENT_ID = "paypal-preview-client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal-preview-secret";

    const { resolvePaymentProviders } = loadProviderConfig();
    const providers = resolvePaymentProviders();

    expect(providers.runtime).toBe("preview");
    expect(providers.previewPaymentsEnabled).toBe(false);
    expect(providers.livePaymentsEnabled).toBe(false);
    expect(providers.razorpay).toEqual({
      enabled: false,
      mode: "test",
    });
    expect(providers.paypal).toEqual({
      enabled: false,
      mode: "sandbox",
      clientId: "",
    });
  });

  test("preview can opt into sandbox and test providers explicitly", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.ENABLE_PREVIEW_PAYMENTS = "1";
    process.env.RAZORPAY_KEY_ID = "rzp_test_preview";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    process.env.PAYPAL_CLIENT_ID = "paypal-preview-client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal-preview-secret";

    const { resolvePaymentProviders } = loadProviderConfig();
    const providers = resolvePaymentProviders();

    expect(providers.runtime).toBe("preview");
    expect(providers.previewPaymentsEnabled).toBe(true);
    expect(providers.livePaymentsEnabled).toBe(false);
    expect(providers.razorpay).toEqual({
      enabled: true,
      mode: "test",
    });
    expect(providers.paypal).toEqual({
      enabled: true,
      mode: "sandbox",
      clientId: "paypal-preview-client",
    });
  });

  test("preview never enables live payment credentials without a live override", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.ENABLE_PREVIEW_PAYMENTS = "1";
    process.env.PAYPAL_ENV = "live";
    process.env.RAZORPAY_KEY_ID = "rzp_live_preview";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    process.env.PAYPAL_CLIENT_ID = "paypal-live-client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal-live-secret";

    const { resolvePaymentProviders } = loadProviderConfig();
    const providers = resolvePaymentProviders();

    expect(providers.livePaymentsEnabled).toBe(false);
    expect(providers.razorpay).toEqual({
      enabled: false,
      mode: "live",
    });
    expect(providers.paypal).toEqual({
      enabled: false,
      mode: "live",
      clientId: "",
    });
  });

  test("preview can opt into live providers explicitly", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.ALLOW_LIVE_PAYMENTS_IN_PREVIEW = "1";
    process.env.RAZORPAY_KEY_ID = "rzp_live_preview";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    process.env.PAYPAL_CLIENT_ID = "paypal-live-client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal-live-secret";

    const { resolvePaymentProviders } = loadProviderConfig();
    const providers = resolvePaymentProviders();

    expect(providers.runtime).toBe("preview");
    expect(providers.previewPaymentsEnabled).toBe(false);
    expect(providers.livePaymentsEnabled).toBe(true);
    expect(providers.razorpay).toEqual({
      enabled: true,
      mode: "live",
    });
    expect(providers.paypal).toEqual({
      enabled: true,
      mode: "live",
      clientId: "paypal-live-client",
    });
  });

  test("production enables live providers only", () => {
    process.env.VERCEL_ENV = "production";
    process.env.PAYPAL_ENV = "live";
    process.env.RAZORPAY_KEY_ID = "rzp_live_prod";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    process.env.PAYPAL_CLIENT_ID = "paypal-live-client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal-live-secret";

    const { resolvePaymentProviders } = loadProviderConfig();
    const providers = resolvePaymentProviders();

    expect(providers.runtime).toBe("production");
    expect(providers.previewPaymentsEnabled).toBe(false);
    expect(providers.livePaymentsEnabled).toBe(true);
    expect(providers.razorpay).toEqual({
      enabled: true,
      mode: "live",
    });
    expect(providers.paypal).toEqual({
      enabled: true,
      mode: "live",
      clientId: "paypal-live-client",
    });
  });
});
