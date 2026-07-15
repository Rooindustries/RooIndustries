import { selectPaymentStartBackend } from "../server/api/payment/backend";
import { issueHoldToken } from "../server/booking/holdToken";
import { issueUpgradeIntentToken } from "../server/api/ref/upgradeIntentToken";

describe("payment backend pinning", () => {
  const originalSecret = process.env.UPGRADE_INTENT_SECRET;

  beforeAll(() => {
    process.env.UPGRADE_INTENT_SECRET =
      "test-upgrade-backend-selection-secret-0001";
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.UPGRADE_INTENT_SECRET;
    else process.env.UPGRADE_INTENT_SECRET = originalSecret;
  });

  test("keeps an upgrade on the backend signed into its intent", () => {
    const bookingPayload = {
      originalOrderId: "booking.original",
      email: "customer@example.com",
      packageTitle: "Performance Vertex Max",
    };
    bookingPayload.upgradeIntentToken = issueUpgradeIntentToken({
      bookingId: bookingPayload.originalOrderId,
      email: bookingPayload.email,
      targetPackageTitle: bookingPayload.packageTitle,
      backend: "supabase",
      cutoverGeneration: 4,
    });

    expect(
      selectPaymentStartBackend({
        body: { bookingPayload },
        env: {
          DATA_PRIMARY_BACKEND: "sanity",
          COMMERCE_PRIMARY_BACKEND: "sanity",
          SUPABASE_COMMERCE_CANARY_PERCENT: "0",
        },
      })
    ).toBe("supabase");
  });

  test("does not trust a tampered upgrade intent for routing", () => {
    expect(
      selectPaymentStartBackend({
        body: {
          bookingPayload: {
            originalOrderId: "booking.original",
            email: "customer@example.com",
            packageTitle: "Performance Vertex Max",
            upgradeIntentToken: "tampered.token",
          },
        },
        env: {
          DATA_PRIMARY_BACKEND: "sanity",
          COMMERCE_PRIMARY_BACKEND: "sanity",
          SUPABASE_COMMERCE_CANARY_PERCENT: "0",
        },
      })
    ).toBe("sanity");
  });

  test("never canaries new payment writes onto a second backend", () => {
    expect(
      selectPaymentStartBackend({
        body: { bookingPayload: { packageTitle: "Performance Vertex Max" } },
        clientAddress: "203.0.113.10",
        env: {
          NODE_ENV: "test",
          DATA_PRIMARY_BACKEND: "sanity",
          COMMERCE_PRIMARY_BACKEND: "sanity",
          SUPABASE_COMMERCE_CANARY_PERCENT: "100",
          SUPABASE_SHADOW_WRITES: "1",
          SANITY_REVERSE_MIRROR_WRITES: "1",
        },
      })
    ).toBe("sanity");
  });

  test("routes a generation-one start to Supabase despite a legacy Sanity hold", () => {
    const slotHoldId = "slotHold.legacy";
    const slotHoldToken = issueHoldToken({
      holdId: slotHoldId,
      startTimeUTC: "2026-07-15T08:00:00.000Z",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      backend: "sanity",
      cutoverGeneration: 0,
    });

    expect(selectPaymentStartBackend({
      body: { bookingPayload: { slotHoldId, slotHoldToken } },
      cutoverGeneration: 1,
      env: {
        DATA_PRIMARY_BACKEND: "supabase",
        COMMERCE_PRIMARY_BACKEND: "supabase",
        SUPABASE_CUTOVER_ENABLED: "1",
        COMMERCE_CUTOVER_ENABLED: "1",
        SANITY_REVERSE_MIRROR_WRITES: "1",
        COMMERCE_FAILOVER_GENERATION: "1",
      },
    })).toBe("supabase");
  });

  test("routes a generation-one upgrade to Supabase despite a legacy Sanity intent", () => {
    const bookingPayload = {
      originalOrderId: "booking.legacy",
      email: "customer@example.com",
      packageTitle: "Performance Vertex Max",
    };
    bookingPayload.upgradeIntentToken = issueUpgradeIntentToken({
      bookingId: bookingPayload.originalOrderId,
      email: bookingPayload.email,
      targetPackageTitle: bookingPayload.packageTitle,
      backend: "sanity",
      cutoverGeneration: 0,
    });

    expect(selectPaymentStartBackend({
      body: { bookingPayload },
      cutoverGeneration: 1,
      env: {
        DATA_PRIMARY_BACKEND: "supabase",
        COMMERCE_PRIMARY_BACKEND: "supabase",
        SUPABASE_CUTOVER_ENABLED: "1",
        COMMERCE_CUTOVER_ENABLED: "1",
        SANITY_REVERSE_MIRROR_WRITES: "1",
        COMMERCE_FAILOVER_GENERATION: "1",
      },
    })).toBe("supabase");
  });

  test("routes new generation-two starts to a manually selected Sanity fallback", () => {
    const slotHoldId = "slotHold.supabase";
    const slotHoldToken = issueHoldToken({
      holdId: slotHoldId,
      startTimeUTC: "2026-07-15T08:00:00.000Z",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      backend: "supabase",
      cutoverGeneration: 1,
    });

    expect(selectPaymentStartBackend({
      body: { bookingPayload: { slotHoldId, slotHoldToken } },
      cutoverGeneration: 2,
      env: {
        DATA_PRIMARY_BACKEND: "sanity",
        COMMERCE_PRIMARY_BACKEND: "sanity",
        COMMERCE_FAILOVER_GENERATION: "2",
      },
    })).toBe("sanity");
  });
});
