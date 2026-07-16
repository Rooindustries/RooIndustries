const mockDrainCommerceMirrorOutbox = jest.fn();

jest.mock("../server/supabase/commerceMirrorOutbox", () => ({
  drainCommerceMirrorOutbox: (...args) => mockDrainCommerceMirrorOutbox(...args),
}));

import { createReverseMirroringSupabaseClient } from "../server/supabase/reverseMirroringClient";

describe("reverse mirror drain bounds", () => {
  test("forwards document ids, limit, and maxBatches to the commerce outbox", async () => {
    const recoveryClient = { rpc: jest.fn() };
    const supabaseClient = {
      commerceOnly: true,
      shadowClient: recoveryClient,
    };
    const sanityClient = { transaction: jest.fn() };
    mockDrainCommerceMirrorOutbox.mockResolvedValue({
      supported: true,
      attempted: 0,
      mirrored: 0,
      failed: 0,
    });
    const client = createReverseMirroringSupabaseClient({
      supabaseClient,
      sanityClient,
    });

    await client.flushCommerceMirror({
      requiredDocumentIds: ["payment.bound"],
      limit: 7,
      maxBatches: 2,
    });

    expect(mockDrainCommerceMirrorOutbox).toHaveBeenCalledWith({
      supabaseClient: recoveryClient,
      sanityClient,
      requiredDocumentIds: ["payment.bound"],
      limit: 7,
      maxBatches: 2,
    });
  });
});
