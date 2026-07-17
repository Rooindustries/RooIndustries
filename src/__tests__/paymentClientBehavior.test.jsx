import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Payment from "../components/Payment";

let mockPayPalButtonProps = null;

jest.mock("framer-motion", () => ({
  motion: new Proxy({}, { get: () => "div" }),
}));

jest.mock("@paypal/react-paypal-js", () => ({
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
