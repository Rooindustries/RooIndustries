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
}));

import { getBookingAvailability } from "../server/booking/availability.js";

describe("getBookingAvailability", () => {
  beforeEach(() => {
    getBookingSettings.mockResolvedValue({
      dateSlots: [{ date: "2099-01-05", times: ["10:00"] }],
      xocDateSlots: [],
      vertexEssentialsDateSlots: [],
      packageDateSlots: [],
    });
    filterActiveBookings.mockImplementation((bookings = []) => bookings);
  });

  test("returns active and expired holds with explicit hold state and no cleanup mutation", async () => {
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
        expect.objectContaining({
          holdId: "hold_expired",
          isHold: true,
          isExpiredHold: true,
          holdState: "expired",
        }),
      ])
    );
  });
});
