import {
  filterActiveBookings,
  getBookingSettings,
} from "../server/booking/slotPolicy.js";

jest.mock("../server/booking/slotPolicy.js", () => ({
  getBookingSettings: jest.fn(),
  filterActiveBookings: jest.fn(),
}));

jest.mock("../server/api/ref/sanity.js", () => ({
  createRefReadClient: jest.fn(),
  createCommerceReadClient: jest.fn(),
}));

import { getBookingAvailability } from "../server/booking/availability.js";
import { createCommerceReadClient } from "../server/api/ref/sanity.js";

describe("getBookingAvailability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getBookingSettings.mockResolvedValue({
      dateSlots: [{ date: "2099-01-05", times: ["10:00"] }],
      xocDateSlots: [],
      vertexEssentialsDateSlots: [],
      packageDateSlots: [],
    });
    filterActiveBookings.mockImplementation((bookings = []) => bookings);
  });

  afterEach(() => {
    delete process.env.COMMERCE_PRIMARY_BACKEND;
    delete process.env.COMMERCE_CUTOVER_ENABLED;
    delete process.env.COMMERCE_FAILOVER_GENERATION;
    delete process.env.SANITY_REVERSE_MIRROR_WRITES;
  });

  test("returns only active holds and performs no cleanup mutation", async () => {
    const client = {
      fetch: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            _id: "hold_active",
            startTimeUTC: "2099-01-05T04:30:00.000Z",
            phase: "payment_pending",
            expiresAt: "2099-01-05T04:45:00.000Z",
          },
          {
            _id: "hold_expired",
            startTimeUTC: "2025-01-05T04:30:00.000Z",
            phase: "pending",
            expiresAt: "2025-01-05T04:35:00.000Z",
          },
        ]),
      delete: jest.fn(),
    };

    const availability = await getBookingAvailability({ client });

    expect(client.delete).not.toHaveBeenCalled();
    expect(availability.bookedSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          holdId: "hold_active",
          isHold: true,
          isExpiredHold: false,
          holdState: "active",
        }),
      ])
    );
    expect(availability.bookedSlots).toHaveLength(1);
  });

  test("treats missing and invalid hold expiry as expired", async () => {
    const client = {
      fetch: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { _id: "missing", startTimeUTC: "2099-01-05T04:30:00.000Z" },
          {
            _id: "invalid",
            startTimeUTC: "2099-01-05T05:30:00.000Z",
            expiresAt: "not-a-date",
          },
        ]),
    };

    const availability = await getBookingAvailability({ client });
    expect(availability.bookedSlots).toEqual([]);
  });

  test("uses one typed availability read when the backend provides it", async () => {
    const client = {
      fetchAvailability: jest.fn().mockResolvedValue({
        bookings: [
          {
            _id: "booking_typed",
            startTimeUTC: "2099-01-05T04:30:00.000Z",
            status: "captured",
          },
        ],
        holds: [],
        slotLocks: [],
      }),
      fetch: jest.fn(),
    };

    const availability = await getBookingAvailability({ client });
    expect(client.fetchAvailability).toHaveBeenCalledTimes(1);
    expect(client.fetch).not.toHaveBeenCalled();
    expect(availability.bookedSlots).toEqual([
      { startTimeUTC: "2099-01-05T04:30:00.000Z", isHold: false },
    ]);
  });

  test("does not contact Sanity after the generation-one Supabase cutover", async () => {
    process.env.COMMERCE_PRIMARY_BACKEND = "supabase";
    process.env.COMMERCE_CUTOVER_ENABLED = "1";
    process.env.COMMERCE_FAILOVER_GENERATION = "1";
    process.env.SANITY_REVERSE_MIRROR_WRITES = "1";
    const supabaseClient = {
      fetchAvailability: jest.fn().mockResolvedValue({
        bookings: [],
        holds: [],
        slotLocks: [],
      }),
    };
    createCommerceReadClient.mockImplementation(({ backendOverride }) => {
      if (backendOverride !== "supabase") {
        throw new Error("Sanity must not be contacted.");
      }
      return supabaseClient;
    });

    await expect(getBookingAvailability()).resolves.toMatchObject({
      bookedSlots: [],
    });
    expect(createCommerceReadClient).toHaveBeenCalledTimes(1);
    expect(createCommerceReadClient).toHaveBeenCalledWith({
      backendOverride: "supabase",
    });
  });

  test("does not contact Supabase during a generation-two Sanity failover", async () => {
    process.env.COMMERCE_PRIMARY_BACKEND = "sanity";
    process.env.COMMERCE_CUTOVER_ENABLED = "1";
    process.env.COMMERCE_FAILOVER_GENERATION = "2";
    const sanityClient = {
      fetchAvailability: jest.fn().mockResolvedValue({
        bookings: [],
        holds: [],
        slotLocks: [],
      }),
    };
    createCommerceReadClient.mockImplementation(({ backendOverride }) => {
      if (backendOverride !== "sanity") {
        throw new Error("Supabase must not be contacted.");
      }
      return sanityClient;
    });

    await expect(getBookingAvailability()).resolves.toMatchObject({
      bookedSlots: [],
    });
    expect(createCommerceReadClient).toHaveBeenCalledTimes(1);
    expect(createCommerceReadClient).toHaveBeenCalledWith({
      backendOverride: "sanity",
    });
  });

  test("keeps the Sanity occupancy barrier before generation one", async () => {
    process.env.COMMERCE_PRIMARY_BACKEND = "supabase";
    process.env.COMMERCE_CUTOVER_ENABLED = "1";
    process.env.COMMERCE_FAILOVER_GENERATION = "0";
    process.env.SANITY_REVERSE_MIRROR_WRITES = "1";
    const clients = {
      supabase: {
        fetchAvailability: jest.fn().mockResolvedValue({
          bookings: [],
          holds: [],
          slotLocks: [],
        }),
      },
      sanity: {
        fetchAvailability: jest.fn().mockResolvedValue({
          bookings: [
            {
              _id: "legacy-booking",
              startTimeUTC: "2099-01-05T04:30:00.000Z",
              status: "captured",
            },
          ],
          holds: [],
          slotLocks: [],
        }),
      },
    };
    createCommerceReadClient.mockImplementation(
      ({ backendOverride }) => clients[backendOverride]
    );

    await expect(getBookingAvailability()).resolves.toMatchObject({
      bookedSlots: [
        { startTimeUTC: "2099-01-05T04:30:00.000Z", isHold: false },
      ],
    });
    expect(createCommerceReadClient).toHaveBeenCalledTimes(2);
    expect(createCommerceReadClient).toHaveBeenCalledWith({
      backendOverride: "supabase",
    });
    expect(createCommerceReadClient).toHaveBeenCalledWith({
      backendOverride: "sanity",
    });
  });
});
