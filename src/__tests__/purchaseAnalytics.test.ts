const mockTrack = jest.fn();
jest.mock("@vercel/analytics/react", () => ({ track: (...args: unknown[]) => mockTrack(...args) }));

beforeEach(() => { jest.resetModules(); mockTrack.mockReset(); sessionStorage.clear(); window.history.replaceState({}, "", "/payment"); });

test("counts one confirmed purchase across retries and removes private identifiers", () => {
  const { trackConfirmedPurchase } = require("../lib/analytics");
  const receipt = { eventId: "a".repeat(40), paymentType: "paid", provider: "paypal", amount: 99.95, currency: "USD", packageTitle: "Performance Vertex Max", referralCode: "winton", attribution: null, email: "buyer@example.invalid" };
  expect(trackConfirmedPurchase(receipt)).toBe(true);
  expect(trackConfirmedPurchase(receipt)).toBe(false);
  expect(mockTrack).toHaveBeenCalledTimes(1);
  expect(mockTrack).toHaveBeenCalledWith("booking_completed", expect.objectContaining({ event_id: receipt.eventId, package: receipt.packageTitle, referral_code: "winton" }));
  expect(mockTrack.mock.calls[0][1]).not.toHaveProperty("email");
  expect(mockTrack.mock.calls[0][1]).not.toHaveProperty("journey_id");
});

test("does not count success-page state without a server receipt", () => {
  const { trackConfirmedPurchase } = require("../lib/analytics");
  expect(trackConfirmedPurchase({ bookingId: "booking.forged", status: "booked" })).toBe(false);
  expect(mockTrack).not.toHaveBeenCalled();
});

test("allows retry after the analytics SDK throws", () => {
  const { trackConfirmedPurchase } = require("../lib/analytics");
  const receipt = { eventId: "b".repeat(40), paymentType: "free", provider: "free", amount: 0, currency: "USD", packageTitle: "Performance Vertex Max" };
  mockTrack.mockImplementationOnce(() => { throw new Error("SDK unavailable"); });
  expect(trackConfirmedPurchase(receipt)).toBe(false);
  expect(trackConfirmedPurchase(receipt)).toBe(true);
});
