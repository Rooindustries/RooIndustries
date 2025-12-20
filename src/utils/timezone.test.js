import { deriveSlotLabels, HOST_TZ_NAME } from "./timezone";

describe("timezone helpers", () => {
  test("detects host/user day differences across midnight boundaries", () => {
    // 2025-12-19 04:00 IST => 2025-12-18 17:30 in America/New_York
    const utcStart = new Date(Date.UTC(2025, 11, 18, 22, 30));

    const labels = deriveSlotLabels(
      utcStart,
      "America/New_York",
      HOST_TZ_NAME
    );

    expect(labels.localDateLabel).toMatch(/December 18/);
    expect(labels.hostDateLabel).toMatch(/Dec 19/);
    expect(labels.crossesDateBoundary).toBe(true);
  });

  test("same calendar day in Gulf time zones", () => {
    // 04:00 IST => 02:30 Asia/Dubai on the SAME calendar day (Dec 19)
    const utcStart = new Date(Date.UTC(2025, 11, 18, 22, 30));

    const labels = deriveSlotLabels(utcStart, "Asia/Dubai", HOST_TZ_NAME);

    expect(labels.localDateLabel).toMatch(/December 19/);
    expect(labels.hostDateLabel).toMatch(/Dec 19/);
    expect(labels.crossesDateBoundary).toBe(false);
  });

  test("far east stays same day", () => {
    // 04:00 IST => 11:30 Pacific/Auckland on Dec 19 (same day as host)
    const utcStart = new Date(Date.UTC(2025, 11, 18, 22, 30));

    const labels = deriveSlotLabels(
      utcStart,
      "Pacific/Auckland",
      HOST_TZ_NAME
    );

    expect(labels.localDateLabel).toMatch(/December 19/);
    expect(labels.hostDateLabel).toMatch(/Dec 19/);
    expect(labels.crossesDateBoundary).toBe(false);
  });

  test("west coast US shifts back a day", () => {
    // 10:00 IST => 20:30 previous day in America/Los_Angeles (crosses boundary)
    const utcStart = new Date(Date.UTC(2025, 11, 19, 4, 30)); // 10:00 IST

    const labels = deriveSlotLabels(
      utcStart,
      "America/Los_Angeles",
      HOST_TZ_NAME
    );

    expect(labels.localDateLabel).toMatch(/December 18/);
    expect(labels.hostDateLabel).toMatch(/Dec 19/);
    expect(labels.crossesDateBoundary).toBe(true);
  });
});
