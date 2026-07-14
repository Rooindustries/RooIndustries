const mockCreateCommerceWriteClient = jest.fn();

jest.mock("../server/api/ref/sanity.js", () => ({
  createCommerceWriteClient: (...args) =>
    mockCreateCommerceWriteClient(...args),
}));

const { fetchOtherBackendSlotState } = require("../server/booking/holdSlot.js");

describe("booking hold backend isolation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.COMMERCE_PRIMARY_BACKEND = "supabase";
    process.env.COMMERCE_CUTOVER_ENABLED = "1";
    process.env.COMMERCE_FAILOVER_GENERATION = "1";
    process.env.SANITY_REVERSE_MIRROR_WRITES = "1";
    mockCreateCommerceWriteClient.mockImplementation(() => {
      throw new Error("Sanity unavailable");
    });
  });

  afterEach(() => {
    delete process.env.COMMERCE_PRIMARY_BACKEND;
    delete process.env.COMMERCE_CUTOVER_ENABLED;
    delete process.env.COMMERCE_FAILOVER_GENERATION;
    delete process.env.SANITY_REVERSE_MIRROR_WRITES;
  });

  test("does not read Sanity after the generation-one Supabase cutover", async () => {
    await expect(
      fetchOtherBackendSlotState({
        backend: "supabase",
        holdId: "hold-1",
        slotLockId: "slot-1",
        startTimeUTC: "2099-01-05T04:30:00.000Z",
      })
    ).resolves.toEqual({ hold: null, slotLock: null, bookings: [] });
    expect(mockCreateCommerceWriteClient).not.toHaveBeenCalled();
  });
});
