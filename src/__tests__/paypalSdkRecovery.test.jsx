import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Payment from "../components/Payment";

jest.mock("framer-motion", () => ({
  motion: new Proxy({}, { get: () => "div" }),
}));

// Exercise the installed provider/reducer and real script load/error events.
// Only the externally rendered payment control is replaced; no transaction runs.
jest.mock("@paypal/react-paypal-js", () => ({
  ...jest.requireActual("@paypal/react-paypal-js"),
  PayPalButtons: () => <button type="button">PayPal checkout control</button>,
}));

test("a failed PayPal SDK can be retried without starting a payment or changing the quote", async () => {
  const originalFetch = global.fetch;
  const originalPaypal = window.paypal;
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  const providers = {
    paypal: { enabled: true, mode: "sandbox", clientId: "sdk-recovery-fixture" },
    razorpay: { enabled: false },
  };
  window.sessionStorage.clear();
  global.fetch = jest.fn(async (url) => {
    if (url === "/api/payment/providers") {
      return { ok: true, json: async () => ({ ok: true, providers }) };
    }
    if (url === "/api/payment/quote") {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          providers,
          quoteFingerprint: "sdk-recovery-quote",
          quote: { grossAmount: 54.95, netAmount: 52.20, discountAmount: 2.75, isFree: false },
        }),
      };
    }
    throw new Error(`Unexpected payment request: ${url}`);
  });

  try {
    render(
      <MemoryRouter initialEntries={[{
        pathname: "/payment",
        state: { bookingData: {
          packageTitle: "Performance Vertex Overhaul",
          packagePrice: "$54.95",
          email: "sdk-recovery@example.invalid",
          startTimeUTC: "2099-01-05T10:00:00.000Z",
          localTimeZone: "UTC",
          displayDate: "Monday, January 5, 2099",
          displayTime: "10:00 AM",
          slotHoldId: "slotHold.sdk-recovery",
          slotHoldToken: "sdk-recovery-hold-token",
          slotHoldExpiresAt: "2099-01-05T10:20:00.000Z",
        } },
      }]}>
        <Payment hideFooter />
      </MemoryRouter>
    );
    await screen.findByText("$52.20 USD");
    const script = document.querySelector('script[src^="https://www.paypal.com/sdk/js"]');
    expect(script).not.toBeNull();
    const initialUrl = script.src;
    const storedCheckout = sessionStorage.getItem("checkout_booking_state");
    const initialRequests = global.fetch.mock.calls.length;
    fireEvent.error(script);

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("PayPal couldn’t load. Please try again.");
    expect(error.closest(".paypal-checkout-shell")).toBeNull();
    expect(screen.queryByRole("button", { name: "PayPal checkout control" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry PayPal" }));

    expect(screen.getByRole("status")).toHaveTextContent("Loading PayPal");
    const retryScript = document.querySelector('script[src^="https://www.paypal.com/sdk/js"]');
    expect(retryScript).not.toBe(script);
    expect(script.isConnected).toBe(false);
    expect(retryScript.src).toBe(initialUrl);
    window.paypal = {};
    fireEvent.load(retryScript);
    await screen.findByRole("button", { name: "PayPal checkout control" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(global.fetch).toHaveBeenCalledTimes(initialRequests);
    expect(sessionStorage.getItem("payment_session_state")).toBeNull();
    expect(sessionStorage.getItem("checkout_booking_state")).toBe(storedCheckout);
    expect(screen.getByText("$52.20 USD")).toBeInTheDocument();
  } finally {
    cleanup();
    document.querySelectorAll('script[src^="https://www.paypal.com/sdk/js"]').forEach((script) => script.remove());
    if (originalPaypal === undefined) delete window.paypal;
    else window.paypal = originalPaypal;
    global.fetch = originalFetch;
    errorSpy.mockRestore();
    window.sessionStorage.clear();
  }
});
