import { selectPaymentStartBackend } from "../server/api/payment/backend";
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
});
