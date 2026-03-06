let getUpgradeInfo;

const mockGetDocument = jest.fn();
const mockFetch = jest.fn();
const mockCreateClient = jest.fn(() => ({
  getDocument: mockGetDocument,
  fetch: mockFetch,
}));

jest.mock("@sanity/client", () => ({
  createClient: (...args) => mockCreateClient(...args),
}));

jest.mock("dotenv", () => ({
  config: jest.fn(),
}));

const createReq = (query = {}, method = "GET") => ({ method, query });

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

beforeAll(() => {
  const mod = require("../../api/ref/getUpgradeInfo");
  getUpgradeInfo = mod && mod.default ? mod.default : mod;
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getUpgradeInfo API", () => {
  test("requires the booking email for upgrade lookup", async () => {
    const req = createReq({ id: "booking_1" });
    const res = createRes();

    await getUpgradeInfo(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "Missing booking email.",
    });
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  test("returns 404 when the booking email does not match", async () => {
    mockGetDocument.mockResolvedValue({
      _id: "booking_1",
      _type: "booking",
      status: "completed",
      email: "client@example.com",
      payerEmail: "payer@example.com",
    });

    const req = createReq({
      id: "booking_1",
      email: "wrong@example.com",
    });
    const res = createRes();

    await getUpgradeInfo(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      ok: false,
      error: "No booking found with that Order ID.",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns upgrade pricing without leaking booking PII", async () => {
    mockGetDocument.mockResolvedValue({
      _id: "booking_1",
      _type: "booking",
      status: "completed",
      email: "client@example.com",
      discord: "servi",
      specs: "secret specs",
      mainGame: "Overwatch 2",
      message: "private notes",
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      displayDate: "Wednesday, January 15, 2025",
      displayTime: "12:00 AM",
      localTimeZone: "America/Los_Angeles",
      startTimeUTC: "2025-01-15T08:00:00.000Z",
    });

    mockFetch
      .mockResolvedValueOnce({
        title: "XOC / Extreme Overclocking",
        price: "$149.95",
      })
      .mockResolvedValueOnce([
        {
          _id: "booking_1",
          packageTitle: "Performance Vertex Overhaul",
          netAmount: 84.99,
        },
      ]);

    const req = createReq({
      id: "booking_1",
      email: "client@example.com",
    });
    const res = createRes();

    await getUpgradeInfo(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.booking).toEqual({
      _id: "booking_1",
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      displayDate: "Wednesday, January 15, 2025",
      displayTime: "12:00 AM",
      localTimeZone: "America/Los_Angeles",
      startTimeUTC: "2025-01-15T08:00:00.000Z",
    });
    expect(res.body.booking.email).toBeUndefined();
    expect(res.body.booking.discord).toBeUndefined();
    expect(res.body.booking.specs).toBeUndefined();
    expect(res.body.booking.mainGame).toBeUndefined();
    expect(res.body.booking.message).toBeUndefined();
    expect(res.body.upgradePrice).toBeCloseTo(64.96, 2);
  });
});
