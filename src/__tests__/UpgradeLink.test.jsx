import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import UpgradeLink from "../components/UpgradeLink";
import { getPublicContent } from "../lib/publicContentClient";

jest.mock("../lib/publicContentClient", () => ({
  getPublicContent: jest.fn(),
}));

const response = (payload, ok = true) => ({
  ok,
  json: async () => payload,
});

const buildUpgradeResponse = (upgradePrice = 45) => ({
  ok: true,
  booking: {
    _id: "booking.upgrade-source",
    packageTitle: "Performance Vertex Overhaul",
    packagePrice: "$54.95",
    displayDate: "Monday, January 5, 2099",
    displayTime: "10:00 AM",
    localTimeZone: "UTC",
    startTimeUTC: "2099-01-05T10:00:00.000Z",
    specs: "Neutral system profile",
    mainGame: "Benchmark title",
  },
  targetPackage: {
    title: "Performance Vertex Max",
    priceString: "$99.95",
    price: 99.95,
  },
  originalPaid: 54.95,
  upgradePrice,
  upgradeIntentToken: "upgrade-intent-neutral",
});

const PaymentState = () => {
  const location = useLocation();
  return (
    <pre data-testid="payment-navigation-state">
      {JSON.stringify(location.state?.bookingData || {})}
    </pre>
  );
};

const renderUpgradeLink = () =>
  render(
    <MemoryRouter initialEntries={["/upgrade/performance-max"]}>
      <Routes>
        <Route path="/upgrade/:slug" element={<UpgradeLink />} />
        <Route path="/payment" element={<PaymentState />} />
      </Routes>
    </MemoryRouter>
  );

const submitLookup = async (payload = buildUpgradeResponse()) => {
  global.fetch = jest.fn().mockResolvedValue(response(payload));
  renderUpgradeLink();

  await screen.findByRole("heading", {
    name: "Upgrade to Performance Vertex Max",
  });
  fireEvent.change(
    screen.getByPlaceholderText("Email used on the original booking"),
    { target: { value: "customer@example.invalid" } }
  );
  fireEvent.change(screen.getByPlaceholderText(/1a2b3c4d5e6f7g8h9i/i), {
    target: { value: "order-neutral-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Check eligibility" }));

  await screen.findByRole("heading", { name: "Upgrade Summary" });
  return payload;
};

describe("upgrade payment handoff", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    getPublicContent.mockResolvedValue({
      title: "Upgrade to Performance Vertex Max",
      intro: "Enter the original booking details to continue.",
      targetPackage: {
        title: "Performance Vertex Max",
        price: "$99.95",
      },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test("renders the upgrade summary after a successful order lookup", async () => {
    await submitLookup();

    expect(screen.getByText("Performance Vertex Overhaul")).toBeInTheDocument();
    expect(screen.getByText("$54.95")).toBeInTheDocument();
    expect(screen.getByText("$45.00")).toBeInTheDocument();
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/ref/getUpgradeInfo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "order-neutral-1",
          email: "customer@example.invalid",
          slug: "performance-max",
        }),
      });
    });
  });

  test("keeps the non-positive price guard active before payment", async () => {
    const payload = await submitLookup();
    const alertSpy = jest.spyOn(window, "alert").mockImplementation(() => {});
    payload.upgradePrice = 0;

    fireEvent.click(
      screen.getByRole("button", { name: "Proceed to Payment" })
    );

    expect(alertSpy).toHaveBeenCalledWith(
      "This order does not require an upgrade payment. Please contact support on Discord."
    );
    expect(screen.queryByTestId("payment-navigation-state")).not.toBeInTheDocument();
  });

  test("stores the priced intent payload before navigating to payment", async () => {
    await submitLookup();

    fireEvent.click(
      screen.getByRole("button", { name: "Proceed to Payment" })
    );

    const stored = JSON.parse(
      window.sessionStorage.getItem("checkout_booking_state")
    );
    expect(stored).toMatchObject({
      email: "customer@example.invalid",
      packageTitle: "Performance Vertex Max (Upgrade)",
      packagePrice: "$45.00",
      originalOrderId: "booking.upgrade-source",
      upgradeIntentToken: "upgrade-intent-neutral",
      startTimeUTC: "2099-01-05T10:00:00.000Z",
    });

    const navigationState = JSON.parse(
      (await screen.findByTestId("payment-navigation-state")).textContent
    );
    expect(navigationState).toEqual(stored);
  });
});
