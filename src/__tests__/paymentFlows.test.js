import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Payment from "../components/Payment";

const CLIENT_EMAIL = "vihaann2.0@gmail.com";
const OWNER_EMAIL = "serviroo@rooindustries.com";

let paypalButtonsProps = null;
let mockLocation = {
  pathname: "/payment",
  search: "",
  hash: "",
  state: null,
};
const mockNavigate = jest.fn();

jest.mock(
  "react-router-dom",
  () => ({
    __esModule: true,
    __setMockLocation: (next) => {
      mockLocation = { ...mockLocation, ...next };
    },
    useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
  Link: ({ to, children, ...rest }) => {
    const href = typeof to === "string" ? to : to?.pathname || "#";
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
  }),
  { virtual: true }
);

const { __setMockLocation } = require("react-router-dom");

jest.mock("@paypal/react-paypal-js", () => ({
  PayPalScriptProvider: ({ children }) => (
    <div data-testid="paypal-provider">{children}</div>
  ),
  PayPalButtons: (props) => {
    paypalButtonsProps = props;
    return <button type="button">PayPal Buttons</button>;
  },
}));

const formatClientDate = (utcDate, timeZone) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(utcDate);

const formatClientTime = (utcDate, timeZone) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(utcDate);

const renderPayment = (bookingData) => {
  const encoded = encodeURIComponent(JSON.stringify(bookingData));
  __setMockLocation({
    pathname: "/payment",
    search: `?data=${encoded}`,
    state: null,
  });
  return render(<Payment />);
};

beforeEach(() => {
  process.env.REACT_APP_PAYPAL_CLIENT_ID = "test-client";
  paypalButtonsProps = null;
  mockNavigate.mockReset();
});

afterEach(() => {
  if (global.fetch && global.fetch.mockReset) {
    global.fetch.mockReset();
  }
});

describe("payment flows", () => {
  test("Razorpay flow attaches UTC and keeps client email data", async () => {
    expect(CLIENT_EMAIL).toBe("vihaann2.0@gmail.com");
    expect(OWNER_EMAIL).toBe("serviroo@rooindustries.com");

    const timeZone = "America/Los_Angeles";
    const startTimeUTC = "2025-01-15T07:59:00.000Z";
    const utcDate = new Date(startTimeUTC);
    const displayDate = formatClientDate(utcDate, timeZone);
    const displayTime = formatClientTime(utcDate, timeZone);

    const bookingData = {
      email: CLIENT_EMAIL,
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$10.00",
      startTimeUTC,
      displayDate,
      displayTime,
      localTimeZone: timeZone,
      slotHoldId: "hold_razorpay",
      slotHoldExpiresAt: "2099-01-05T06:00:00.000Z",
    };

    const fetchCalls = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      if (url === "/api/razorpay/createOrder") {
        const body = JSON.parse(options.body || "{}");
        fetchCalls.push({ url, body });
        return {
          ok: true,
          json: async () => ({
            ok: true,
            orderId: "order_rzp_1",
            amount: 1000,
            currency: "USD",
            key: "rzp_key",
          }),
        };
      }
      if (url === "/api/razorpay/verify") {
        const body = JSON.parse(options.body || "{}");
        fetchCalls.push({ url, body });
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (url === "/api/ref/createBooking") {
        const body = JSON.parse(options.body || "{}");
        fetchCalls.push({ url, body });
        return { ok: true, json: async () => ({ bookingId: "b1" }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    let razorpayOptions = null;
    window.Razorpay = jest.fn().mockImplementation((options) => {
      razorpayOptions = options;
      return {
        open: jest.fn(() => {
          options.handler({
            razorpay_order_id: "order_rzp_1",
            razorpay_payment_id: "pay_rzp_1",
            razorpay_signature: "sig_rzp_1",
          });
        }),
      };
    });

    renderPayment(bookingData);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const script = document.querySelector(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]'
    );
    expect(script).toBeTruthy();

    await act(async () => {
      script.onload();
    });

    const razorpayButton = await screen.findByRole("button", {
      name: /pay with razorpay/i,
    });

    await waitFor(() => expect(razorpayButton).not.toBeDisabled());

    await act(async () => {
      await userEvent.click(razorpayButton);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(razorpayOptions).toBeTruthy());
    const orderCall = fetchCalls.find(
      (call) => call.url === "/api/razorpay/createOrder"
    );
    expect(orderCall.body.notes.startTimeUTC).toBe(startTimeUTC);
    expect(orderCall.body.notes.date).toBe(displayDate);
    expect(orderCall.body.notes.time).toBe(displayTime);

    const bookingCall = fetchCalls.find(
      (call) => call.url === "/api/ref/createBooking"
    );
    expect(bookingCall.body.email).toBe(CLIENT_EMAIL);
    expect(bookingCall.body.startTimeUTC).toBe(startTimeUTC);
    expect(bookingCall.body.displayDate).toBe(displayDate);
    expect(bookingCall.body.displayTime).toBe(displayTime);
    expect(bookingCall.body.paymentProvider).toBe("razorpay");
  });

  test("PayPal flow attaches UTC and keeps client email data", async () => {
    expect(CLIENT_EMAIL).toBe("vihaann2.0@gmail.com");
    expect(OWNER_EMAIL).toBe("serviroo@rooindustries.com");

    const timeZone = "America/Los_Angeles";
    const startTimeUTC = "2025-01-15T08:00:00.000Z";
    const utcDate = new Date(startTimeUTC);
    const displayDate = formatClientDate(utcDate, timeZone);
    const displayTime = formatClientTime(utcDate, timeZone);

    const bookingData = {
      email: CLIENT_EMAIL,
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$10.00",
      startTimeUTC,
      displayDate,
      displayTime,
      localTimeZone: timeZone,
      slotHoldId: "hold_paypal",
      slotHoldExpiresAt: "2099-01-05T06:00:00.000Z",
    };

    const fetchCalls = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      if (url === "/api/ref/createBooking") {
        const body = JSON.parse(options.body || "{}");
        fetchCalls.push({ url, body });
        return { ok: true, json: async () => ({ bookingId: "b2" }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    renderPayment(bookingData);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(paypalButtonsProps).toBeTruthy();

    const createSpy = jest.fn().mockResolvedValue("paypal_order_1");
    await paypalButtonsProps.createOrder({}, { order: { create: createSpy } });

    const createArgs = createSpy.mock.calls[0][0];
    expect(createArgs.purchase_units[0].custom_id).toBe(startTimeUTC);

    const captureSpy = jest.fn().mockResolvedValue({
      id: "paypal_order_1",
      payer: { email_address: CLIENT_EMAIL },
    });

    await paypalButtonsProps.onApprove({}, { order: { capture: captureSpy } });

    const bookingCall = fetchCalls.find(
      (call) => call.url === "/api/ref/createBooking"
    );
    expect(bookingCall.body.email).toBe(CLIENT_EMAIL);
    expect(bookingCall.body.startTimeUTC).toBe(startTimeUTC);
    expect(bookingCall.body.displayDate).toBe(displayDate);
    expect(bookingCall.body.displayTime).toBe(displayTime);
    expect(bookingCall.body.paymentProvider).toBe("paypal");
    expect(bookingCall.body.payerEmail).toBe(CLIENT_EMAIL);
  });
});
