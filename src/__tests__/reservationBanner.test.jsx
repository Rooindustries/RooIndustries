import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
});
