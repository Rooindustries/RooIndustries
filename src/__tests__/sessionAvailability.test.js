import { getSessionAvailability } from "../lib/sessionAvailability";

describe("session availability", () => {
  const now = new Date("2026-09-02T09:30:00.000Z");

  test("shows the engineer online when the earliest free slot is one hour away", () => {
    const availability = getSessionAvailability(
      {
        settings: {
          dateSlots: [{ date: "2026-09-02", times: ["16", "17"] }],
          packageDateSlots: [
            { dateSlots: [{ date: "2026-09-02", times: ["15"] }] },
          ],
        },
        bookedSlots: [
          { startTimeUTC: "2026-09-02T09:30:00.000Z", isHold: false },
        ],
      },
      now
    );

    expect(availability).toMatchObject({
      startTimeUTC: "2026-09-02T10:30:00.000Z",
      isOnline: true,
      label: "Engineer Online",
    });
  });

  test("shows two hours once the next slot is outside the online window", () => {
    const availability = getSessionAvailability(
      {
        settings: {
          dateSlots: [{ date: "2026-09-02", times: ["17"] }],
        },
        bookedSlots: [],
      },
      now
    );

    expect(availability).toMatchObject({
      startTimeUTC: "2026-09-02T11:30:00.000Z",
      isOnline: false,
      label: "Available in 2 hours",
    });
  });

  test("returns no status when there is no future session", () => {
    expect(
      getSessionAvailability(
        {
          settings: {
            dateSlots: [{ date: "2026-09-02", times: ["14"] }],
          },
          bookedSlots: [],
        },
        now
      )
    ).toBeNull();
  });
});
