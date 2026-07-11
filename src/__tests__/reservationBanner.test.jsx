import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import ReservationBanner from "../components/ReservationBanner";

const activeHold = {
  holdId: "slotHold.banner-regression",
  holdToken: "hold-token",
  expiresAt: "2099-01-01T00:20:00.000Z",
  startTimeUTC: "2099-01-01T00:00:00.000Z",
  packageTitle: "XOC / Extreme Overclocking",
  packagePrice: "$99.95",
  phase: "payment_pending",
};

const PaymentStateProbe = () => {
  const location = useLocation();
  return <div>{location.state?.bookingData?.slotHoldToken || "missing checkout"}</div>;
};

describe("reservation banner", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem("my_slot_hold", JSON.stringify(activeHold));
    window.matchMedia = jest.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }));
  });

  test("renders a restored payment hold with its public package title", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ReservationBanner />
      </MemoryRouter>
    );

    expect(
      await screen.findByText(/Performance Vertex Max/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Return to payment" })
    ).toBeInTheDocument();
  });

  test("returns to payment with the stored checkout payload", async () => {
    window.sessionStorage.setItem(
      "checkout_booking_state",
      JSON.stringify({
        packageTitle: "Performance Vertex Max",
        slotHoldId: activeHold.holdId,
        slotHoldToken: activeHold.holdToken,
        slotHoldExpiresAt: activeHold.expiresAt,
      })
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<ReservationBanner />} />
          <Route path="/payment" element={<PaymentStateProbe />} />
        </Routes>
      </MemoryRouter>
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Return to payment" })
    );

    expect(await screen.findByText(activeHold.holdToken)).toBeInTheDocument();
  });
});
