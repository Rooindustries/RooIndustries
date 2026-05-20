const loadGate = () => {
  jest.resetModules();
  return require("../lib/indiaLaunchGate.js");
};

describe("India launch gate", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SITE_MARKET;
    delete process.env.NEXT_PUBLIC_SITE_MARKET;
    delete process.env.INDIA_BOOKING_STATUS;
    delete process.env.NEXT_PUBLIC_INDIA_BOOKING_STATUS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test("keeps global bookings open", () => {
    const { getIndiaBookingGate } = loadGate();
    expect(
      getIndiaBookingGate({ market: { id: "global" } })
    ).toMatchObject({
      status: "open",
      isOpen: true,
      isComingSoon: false,
    });
  });

  test("defaults India bookings to coming soon", () => {
    const { getIndiaBookingGate } = loadGate();
    expect(
      getIndiaBookingGate({ market: { id: "india" } })
    ).toMatchObject({
      status: "coming-soon",
      isOpen: false,
      isComingSoon: true,
    });
  });

  test("opens India bookings only through explicit env", () => {
    process.env.SITE_MARKET = "india";
    process.env.INDIA_BOOKING_STATUS = "open";

    const { getCurrentIndiaBookingGate } = loadGate();

    expect(getCurrentIndiaBookingGate()).toMatchObject({
      status: "open",
      isOpen: true,
      isComingSoon: false,
    });
  });
});
