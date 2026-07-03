import {
  buildBalance,
  computeEarningsFromBookings,
} from "../server/api/ref/payoutUtils";

describe("referral payout utilities", () => {
  test("reduces owed balance by logged payments", () => {
    const balance = buildBalance({ xoc: 75, vertex: 25, total: 100 }, 40, 10);

    expect(balance.payments).toEqual({ xoc: 40, vertex: 10, total: 50 });
    expect(balance.remaining).toEqual({ xoc: 35, vertex: 15, total: 50 });
    expect(balance.owed).toEqual({ xoc: 35, vertex: 15, total: 50 });
    expect(balance.overpaid).toEqual({ xoc: 0, vertex: 0, total: 0 });
  });

  test("clamps owed to zero and exposes overpaid amounts", () => {
    const balance = buildBalance({ xoc: 30, vertex: 10, total: 40 }, 55, 5);

    expect(balance.remaining).toEqual({ xoc: -25, vertex: 5, total: -20 });
    expect(balance.owed).toEqual({ xoc: 0, vertex: 5, total: 0 });
    expect(balance.overpaid).toEqual({ xoc: 25, vertex: 0, total: 20 });
  });

  test("uses stored commission amount before percent fallback", () => {
    const earnings = computeEarningsFromBookings([
      {
        packageTitle: "Performance Vertex Overhaul",
        commissionAmount: 12.5,
        commissionPercent: 50,
        netAmount: 100,
        grossAmount: 100,
      },
    ]);

    expect(earnings.vertex).toBe(12.5);
    expect(earnings.total).toBe(12.5);
    expect(earnings.byPackage["Performance Vertex Overhaul"]).toBe(12.5);
  });

  test("classifies Performance Vertex Max in the top package bucket", () => {
    const earnings = computeEarningsFromBookings([
      {
        packageTitle: "Performance Vertex Max",
        commissionAmount: 15,
        netAmount: 100,
      },
    ]);

    expect(earnings.xoc).toBe(15);
    expect(earnings.vertex).toBe(0);
    expect(earnings.total).toBe(15);
  });
});
