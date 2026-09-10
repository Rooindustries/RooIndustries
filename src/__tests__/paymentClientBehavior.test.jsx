import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Payment from "../components/Payment";

let mockPayPalButtonProps = null;

jest.mock("framer-motion", () => ({
  motion: new Proxy({}, { get: () => "div" }),
}));

jest.mock("@paypal/react-paypal-js", () => ({
  usePayPalScriptReducer: () => [{ isResolved: true, isRejected: false }],
  PayPalButtons: (props) => {
    mockPayPalButtonProps = props;
    return (
      <button type="button" onClick={() => props.onCancel?.()}>
        PayPal test control
      </button>
    );
  },
  PayPalScriptProvider: ({ children }) => <>{children}</>,
}));

const checkout = {
  packageTitle: "Performance Vertex Overhaul",
  packagePrice: "$54.95",
  email: "customer@example.invalid",
  displayDate: "Monday, January 5, 2099",
  displayTime: "10:00 AM",
  localTimeZone: "UTC",
  startTimeUTC: "2099-01-05T10:00:00.000Z",
  slotHoldId: "slotHold.payment-client",
  slotHoldToken: "slot-hold-token",
  slotHoldExpiresAt: "2099-01-05T10:20:00.000Z",
};

const response = (payload, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => payload,
});

const providerPayload = {
  ok: true,
  providers: {
    razorpay: { enabled: false, mode: "test" },
    paypal: {
      enabled: true,
      mode: "sandbox",
      clientId: "paypal_public_client",
    },
  },
};

const quotePayload = {
  ok: true,
  quoteFingerprint: "payment-client-quote",
  quote: {
    grossAmount: 54.95,
    netAmount: 54.95,
    discountAmount: 0,
    isFree: false,
  },
  providers: providerPayload.providers,
};

const renderPayment = () =>
  render(
    <MemoryRouter
      initialEntries={[{ pathname: "/payment", state: { bookingData: checkout } }]}
    >
      <Payment hideFooter />
    </MemoryRouter>
  );

const standardFetch = jest.fn(async (url) => {
  if (String(url) === "/api/payment/providers") {
    return response(providerPayload);
  }
  if (String(url) === "/api/payment/quote") {
    return response(quotePayload);
  }
  throw new Error(`Unexpected request: ${url}`);
});

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("payment client request and accessibility behavior", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPayPalButtonProps = null;
    window.sessionStorage.clear();
    process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID = "paypal_public_client";
  });

  afterEach(() => {
    cleanup();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    delete process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;
  });

  test("announces banners and preserves visible keyboard focus styles", async () => {
    global.fetch = standardFetch;
    renderPayment();

    await waitFor(() => expect(mockPayPalButtonProps).toBeTruthy());
    fireEvent.click(
      screen.getByRole("button", { name: "PayPal test control" })
    );

    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(banner).toHaveAttribute("aria-atomic", "true");
    expect(banner).toHaveTextContent(
      "Checkout closed. Your payment session is still reserved for PayPal."
    );

    const referralInput = screen.getByLabelText("Referral Code (optional)");
    const couponInput = screen.getByLabelText("Coupon Code (optional)");
    for (const input of [referralInput, couponInput]) {
      expect(input).toHaveClass(
        "focus-visible:outline-none",
        "focus-visible:ring-2",
        "focus-visible:ring-info-border"
      );
    }
  });

  test("reconciles a Dodo return before an expired hold can redirect the customer", async () => {
    const booking = { ...checkout, slotHoldExpiresAt: "2000-01-01T00:00:00.000Z" };
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(booking));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      paymentAccessToken: "dodo-return-token",
      providerPayload: { orderId: "cks_return" },
      fingerprint: JSON.stringify({ packageTitle: booking.packageTitle, originalOrderId: "", startTimeUTC: booking.startTimeUTC, email: booking.email, referralCode: "", couponCode: "" }),
    }));
    let finishFinalization;
    global.fetch = jest.fn(async (url) => {
      if (url === "/api/payment/finalize") return new Promise(resolve => {
        finishFinalization = () => resolve(response({ ok: true, status: "booked", bookingId: "booking_return" }));
      });
      if (url === "/api/payment/providers") return response({ ...providerPayload, providers: { ...providerPayload.providers, dodo: { enabled: true, mode: "live" } } });
      return standardFetch(url);
    });
    render(<MemoryRouter initialEntries={[{ pathname: "/payment", search: "?dodo_return=1" }]}>
      <Routes>
        <Route path="/payment" element={<Payment hideFooter />} />
        <Route path="/booking" element={<div>Expired checkout</div>} />
        <Route path="/payment-success" element={<div>Confirmed Dodo booking</div>} />
      </Routes>
    </MemoryRouter>);
    await waitFor(() => expect(finishFinalization).toEqual(expect.any(Function)));
    expect(screen.queryByText("Expired checkout")).not.toBeInTheDocument();
    await act(async () => { finishFinalization(); });
    expect(await screen.findByText("Confirmed Dodo booking")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith("/api/payment/finalize", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer dodo-return-token" }) }));
  });

  test.each(["failed", "abandoned", "refunded", "poll-failed", "manual-failed", "resume-failed"])("clears a released Dodo hold after %s", async (outcome) => {
    jest.useFakeTimers();
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
    sessionStorage.setItem("my_slot_hold", JSON.stringify({
      holdId: checkout.slotHoldId,
      holdToken: checkout.slotHoldToken,
      expiresAt: checkout.slotHoldExpiresAt,
      phase: "payment_pending",
    }));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      paymentAccessToken: "dodo-failed-token",
      providerPayload: { orderId: "cks_failed" },
      fingerprint: JSON.stringify({ packageTitle: checkout.packageTitle, originalOrderId: "", startTimeUTC: checkout.startTimeUTC, email: checkout.email, referralCode: "", couponCode: "" }),
    }));
    global.fetch = jest.fn(async (url) => {
      if (url === "/api/payment/finalize") return response({ ok: true, status: outcome === "poll-failed" ? "finalizing" : outcome.endsWith("-failed") ? "failed" : outcome });
      if (url === "/api/payment/status") return response({ ok: true, status: "failed" });
      if (url === "/api/payment/providers") return response({ ...providerPayload, providers: { ...providerPayload.providers, dodo: { enabled: true, mode: "live" } } });
      return standardFetch(url);
    });
    const manualCheck = outcome === "manual-failed" || outcome === "resume-failed";
    render(<MemoryRouter initialEntries={[{ pathname: "/payment", search: manualCheck ? "" : "?dodo_return=1" }]}>
      <Payment hideFooter />
    </MemoryRouter>);

    if (manualCheck) {
      const name = outcome === "manual-failed" ? "Check payment status" : "Resume checkout";
      const button = await screen.findByRole("button", { name });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
    }
    await screen.findByText(/Go back to booking to choose a time/);
    expect(sessionStorage.getItem("my_slot_hold")).toBeNull();
    expect(sessionStorage.getItem("payment_session_state")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("checkout_booking_state"))).toMatchObject({
      email: checkout.email,
      slotHoldId: "",
      slotHoldToken: "",
      slotHoldExpiresAt: "",
    });
    expect(screen.getByRole("button", { name: "Pay your way" })).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalledWith("/api/payment/start", expect.anything());
    await act(async () => { jest.advanceTimersByTime(5000); await flushMicrotasks(); });
    expect(screen.getByRole("alert")).toHaveTextContent(/Go back to booking to choose a time/);
  });

  test.each([null, {
    provider: "paypal",
    paymentAccessToken: "new-payment-token",
    providerPayload: { orderId: "paypal-new-order" },
    fingerprint: JSON.stringify({
      packageTitle: checkout.packageTitle,
      originalOrderId: "",
      startTimeUTC: checkout.startTimeUTC,
      email: checkout.email,
      referralCode: "",
      couponCode: "",
    }),
  }])("ignores a terminal response after its session was replaced: %s", async (replacement) => {
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo",
      paymentAccessToken: "old-payment-token",
      providerPayload: { orderId: "cks_old" },
      fingerprint: JSON.stringify({ packageTitle: checkout.packageTitle, originalOrderId: "", startTimeUTC: checkout.startTimeUTC, email: checkout.email, referralCode: "", couponCode: "" }),
    }));
    let finishFinalization;
    global.fetch = jest.fn(async (url) => {
      if (url === "/api/payment/finalize") return new Promise(resolve => {
        finishFinalization = () => resolve(response({ ok: true, status: "abandoned" }));
      });
      return standardFetch(url);
    });
    render(<MemoryRouter initialEntries={[{ pathname: "/payment", search: "?dodo_return=1" }]}>
      <Payment hideFooter />
    </MemoryRouter>);
    await waitFor(() => expect(finishFinalization).toEqual(expect.any(Function)));
    const refreshedHold = { holdId: checkout.slotHoldId, holdToken: "refreshed-hold-token", expiresAt: checkout.slotHoldExpiresAt };
    sessionStorage.setItem("my_slot_hold", JSON.stringify(refreshedHold));
    sessionStorage.setItem("checkout_booking_state", JSON.stringify({ ...checkout, slotHoldToken: refreshedHold.holdToken }));
    if (replacement) sessionStorage.setItem("payment_session_state", JSON.stringify(replacement));
    else sessionStorage.removeItem("payment_session_state");

    await act(async () => { finishFinalization(); await flushMicrotasks(); });

    expect(JSON.parse(sessionStorage.getItem("my_slot_hold"))).toEqual(refreshedHold);
    expect(JSON.parse(sessionStorage.getItem("checkout_booking_state")).slotHoldToken).toBe(refreshedHold.holdToken);
    expect(JSON.parse(sessionStorage.getItem("payment_session_state"))).toEqual(replacement);
    expect(screen.queryByText(/Go back to booking to choose a time/)).not.toBeInTheDocument();
  });

  test("expires the refreshed hold after a canceled Dodo return", async () => {
    jest.useFakeTimers();
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo", paymentAccessToken: "dodo-cancel-token",
      providerPayload: { orderId: "cks_cancel" },
      fingerprint: JSON.stringify({ packageTitle: checkout.packageTitle, originalOrderId: "", startTimeUTC: checkout.startTimeUTC, email: checkout.email, referralCode: "", couponCode: "" }),
    }));
    global.fetch = jest.fn(async (url) => {
      if (url === "/api/payment/cancel") return response({
        ok: true, cancelled: true,
        refreshedHold: {
          slotHoldId: checkout.slotHoldId,
          slotHoldToken: "refreshed-token",
          slotHoldExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      return standardFetch(url);
    });
    render(<MemoryRouter initialEntries={[{ pathname: "/payment", search: "?dodo_cancel=1" }]}>
      <Routes>
        <Route path="/payment" element={<Payment hideFooter />} />
        <Route path="/booking" element={<div>Expired checkout</div>} />
      </Routes>
    </MemoryRouter>);
    await screen.findByText("Payment method released. Choose a payment method below.");
    await act(async () => { jest.advanceTimersByTime(60_001); await flushMicrotasks(); });
    expect(screen.getByText("Expired checkout")).toBeInTheDocument();
  });

  test("offers Dodo checkout resumption and restores method selection after release", async () => {
    sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
    sessionStorage.setItem("payment_session_state", JSON.stringify({
      provider: "dodo", paymentAccessToken: "dodo-cancel-token",
      providerPayload: { orderId: "cks_cancel", checkoutUrl: "https://checkout.dodopayments.com/session/cks_cancel" },
      fingerprint: JSON.stringify({ packageTitle: checkout.packageTitle, originalOrderId: "", startTimeUTC: checkout.startTimeUTC, email: checkout.email }),
    }));
    global.fetch = jest.fn(async url => {
      if (url === "/api/payment/providers") return response({ ...providerPayload, providers: { ...providerPayload.providers, dodo: { enabled: true, mode: "live" } } });
      if (url === "/api/payment/cancel") return response({ ok: true, cancelled: true, refreshedHold: {
        slotHoldId: checkout.slotHoldId, slotHoldToken: "refreshed-token", slotHoldExpiresAt: checkout.slotHoldExpiresAt,
      } });
      return standardFetch(url);
    });
    renderPayment();
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume checkout" })).toBeEnabled());
    expect(screen.getByText("Razorpay", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/UPI|wallets/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change payment method" }));
    await screen.findByText("Payment method released. Choose a payment method below.");
    expect(sessionStorage.getItem("payment_session_state")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("my_slot_hold"))).toMatchObject({ phase: "holding", holdToken: "refreshed-token" });
    expect(screen.getByRole("button", { name: "Pay your way" })).toBeEnabled();
  });

  test("aborts a stalled quote and exposes an assertive retry message", async () => {
    jest.useFakeTimers();
    let quoteSignal;
    let quoteCalls = 0;
    global.fetch = jest.fn((url, options = {}) => {
      if (String(url) === "/api/payment/providers") {
        return Promise.resolve(response(providerPayload));
      }
      if (String(url) === "/api/payment/quote") {
        quoteCalls += 1;
        if (quoteCalls > 1) {
          return Promise.resolve(response(quotePayload));
        }
        quoteSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    renderPayment();

    await waitFor(() => expect(quoteSignal).toBeTruthy());
    await act(async () => {
      jest.advanceTimersByTime(15_000);
      await flushMicrotasks();
    });

    expect(quoteSignal.aborted).toBe(true);
    const banner = screen.getByRole("alert");
    expect(banner).toHaveAttribute("aria-live", "assertive");
    expect(banner).toHaveTextContent(
      "Checkout price confirmation took too long. Please try again."
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Retry price check" })
    );
    await act(async () => {
      await flushMicrotasks();
    });
    await waitFor(() => expect(quoteCalls).toBe(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("$54.95 USD")).toBeInTheDocument();
  });

  test("retries stalled status requests within the overall poll budget", async () => {
    jest.useFakeTimers();
    const statusSignals = [];
    global.fetch = jest.fn((url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl === "/api/payment/providers") {
        return Promise.resolve(response(providerPayload));
      }
      if (requestUrl === "/api/payment/quote") {
        return Promise.resolve(response(quotePayload));
      }
      if (requestUrl === "/api/payment/start") {
        return Promise.resolve(
          response({
            ok: true,
            status: "started",
            paymentAccessToken: "payment-access-token",
            providerPayload: { orderId: "paypal_order_poll" },
          })
        );
      }
      if (requestUrl === "/api/payment/finalize") {
        return Promise.resolve(
          response(
            { ok: true, status: "needs_recovery" },
            { ok: true, status: 202 }
          )
        );
      }
      if (requestUrl === "/api/payment/status") {
        statusSignals.push(options.signal);
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    jest.spyOn(console, "error").mockImplementation(() => {});
    renderPayment();

    await waitFor(() => expect(mockPayPalButtonProps).toBeTruthy());
    const payPalProps = mockPayPalButtonProps;
    let orderId;
    await act(async () => {
      orderId = await payPalProps.createOrder();
    });
    expect(orderId).toBe("paypal_order_poll");

    let approvalPromise;
    await act(async () => {
      approvalPromise = payPalProps.onApprove(
        { orderID: orderId },
        {
          order: {
            capture: async () => ({
              id: orderId,
              payer: { email_address: "customer@example.invalid" },
            }),
          },
        }
      );
      await flushMicrotasks();
    });
    await waitFor(() => expect(statusSignals).toHaveLength(1));

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await act(async () => {
        jest.advanceTimersByTime(15_000);
        await flushMicrotasks();
      });
      if (attempt === 0) {
        expect(statusSignals).toHaveLength(2);
      }
    }
    await act(async () => {
      await approvalPromise;
    });

    expect(statusSignals).toHaveLength(6);
    expect(statusSignals.every((signal) => signal.aborted)).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Payment succeeded but something went wrong saving your booking. Please contact support."
    );
  });
});
