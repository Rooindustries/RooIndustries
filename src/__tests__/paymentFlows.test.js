import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Payment from "../components/Payment";

let paypalButtonsProps = null;
let mockLocation = {
  pathname: "/payment",
  search: "",
  hash: "",
  state: null,
};
const mockNavigate = jest.fn();

jest.mock("react-router-dom", () => ({
  __esModule: true,
  __setMockLocation: (next) => {
    mockLocation = { ...mockLocation, ...next };
  },
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
  Link: ({ to, children, state, ...rest }) => {
    const href = typeof to === "string" ? to : to?.pathname || "#";
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

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

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const bookingFixture = (overrides = {}) => ({
  email: "client@example.com",
  packageTitle: "Performance Vertex Overhaul",
  packagePrice: "$10.00",
  startTimeUTC: "2099-01-15T08:00:00.000Z",
  displayDate: "Thursday, January 15, 2099",
  displayTime: "1:30 PM",
  localTimeZone: "Asia/Kolkata",
  slotHoldId: "hold_1",
  slotHoldToken: "hold_token_1",
  slotHoldExpiresAt: "2099-01-15T08:20:00.000Z",
  ...overrides,
});

const renderPayment = (bookingData, search = "") => {
  __setMockLocation({
    pathname: "/payment",
    search,
    hash: "",
    state: { bookingData },
  });
  return render(<Payment />);
};

const loadRazorpay = async () => {
  let script = null;
  await waitFor(() => {
    script = document.querySelector(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]'
    );
    expect(script).toBeTruthy();
  });
  await act(async () => {
    script.onload();
  });
};

beforeEach(() => {
  process.env.REACT_APP_PAYPAL_CLIENT_ID = "test-client";
  paypalButtonsProps = null;
  mockNavigate.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  __setMockLocation({ pathname: "/payment", search: "", hash: "", state: null });
});

afterEach(() => {
  jest.useRealTimers();
  delete window.Razorpay;
  if (global.fetch?.mockReset) global.fetch.mockReset();
});

describe("payment session UI", () => {
  test("does not load the Razorpay SDK while the provider is disabled", async () => {
    global.fetch = jest.fn(async (url) => {
      if (url === "/api/payment/providers") {
        return response({
          ok: true,
          providers: {
            razorpay: {
              enabled: false,
              mode: "live",
              disabledReason: "merchant_profile_update",
            },
            paypal: { enabled: false, mode: "missing", clientId: "" },
          },
        });
      }
      return response({
        ok: true,
        quoteFingerprint: "quote_disabled",
        quote: { grossAmount: 10, netAmount: 10, isFree: false },
      });
    });

    renderPayment(bookingFixture());
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith("/api/payment/providers")
    );
    expect(
      document.querySelector(
        'script[src="https://checkout.razorpay.com/v1/checkout.js"]'
      )
    ).toBeNull();
    expect(
      await screen.findByText(/temporarily unavailable while we update/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /temporarily unavailable/i })
    ).toBeDisabled();
  });

  test("Razorpay uses a server quote, bearer finalize, and refreshed hold", async () => {
    const bookingData = bookingFixture();
    const fetchCalls = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      fetchCalls.push({ url, options, body: JSON.parse(options.body || "{}") });
      if (url === "/api/payment/providers") {
        return response({
          ok: true,
          providers: {
            razorpay: { enabled: true, mode: "live" },
            paypal: { enabled: false, mode: "live" },
          },
        });
      }
      if (url === "/api/payment/quote") {
        return response({
          ok: true,
          quoteFingerprint: "quote_fp_1",
          quote: { grossAmount: 10, discountAmount: 0, netAmount: 10, isFree: false },
        });
      }
      if (url === "/api/payment/start") {
        return response({
          ok: true,
          quoteFingerprint: "quote_fp_1",
          quote: { grossAmount: 10, discountAmount: 0, netAmount: 10, isFree: false },
          paymentAccessToken: "payment_access_rzp",
          sessionExpiresAt: "2099-01-15T08:20:00.000Z",
          refreshedHold: {
            slotHoldId: "hold_1",
            slotHoldToken: "hold_token_refreshed",
            slotHoldExpiresAt: "2099-01-15T08:20:00.000Z",
          },
          providerPayload: {
            orderId: "order_rzp_1",
            amount: 1000,
            currency: "USD",
            key: "rzp_key",
          },
        });
      }
      if (url === "/api/payment/finalize") {
        return response({
          ok: true,
          bookingId: "booking_1",
          status: "email_partial",
          emailDispatchToken: "dispatch_1",
        });
      }
      return response({ ok: true });
    });

    let razorpayOptions = null;
    window.Razorpay = jest.fn((options) => {
      razorpayOptions = options;
      return {
        open: jest.fn(() =>
          options.handler({
            razorpay_order_id: "order_rzp_1",
            razorpay_payment_id: "pay_rzp_1",
            razorpay_signature: "sig_rzp_1",
          })
        ),
      };
    });

    renderPayment(bookingData);
    await loadRazorpay();
    const button = await screen.findByRole("button", { name: /pay with razorpay/i });
    await waitFor(() => expect(button).not.toBeDisabled());

    await act(async () => {
      await userEvent.click(button);
    });
    await waitFor(() => expect(razorpayOptions).toBeTruthy());
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith("/payment-success", expect.anything())
    );

    const start = fetchCalls.find((call) => call.url === "/api/payment/start");
    const quote = fetchCalls.find((call) => call.url === "/api/payment/quote");
    expect(quote.body.startTimeUTC).toBe(bookingData.startTimeUTC);
    expect(quote.body.email).toBe(bookingData.email);
    expect(start.body.quoteFingerprint).toBe("quote_fp_1");
    expect(start.body.bookingPayload.email).toBe("client@example.com");
    expect(start.body.bookingPayload.slotHoldToken).toBe("hold_token_1");

    const finalize = fetchCalls.find(
      (call) => call.url === "/api/payment/finalize"
    );
    expect(finalize.options.headers.Authorization).toBe(
      "Bearer payment_access_rzp"
    );
    expect(finalize.body.paymentAccessToken).toBeUndefined();
    expect(finalize.body.providerData).toEqual({
      razorpayOrderId: "order_rzp_1",
      razorpayPaymentId: "pay_rzp_1",
      razorpaySignature: "sig_rzp_1",
    });
    expect(
      JSON.parse(window.localStorage.getItem("my_slot_hold"))?.holdToken
    ).toBeUndefined();
  });

  test("PayPal uses only the server-created order and bearer finalize", async () => {
    const fetchCalls = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      fetchCalls.push({ url, options, body: JSON.parse(options.body || "{}") });
      if (url === "/api/payment/providers") {
        return response({
          ok: true,
          providers: {
            razorpay: { enabled: true, mode: "live" },
            paypal: { enabled: true, mode: "live", clientId: "test-client" },
          },
        });
      }
      if (url === "/api/payment/quote") {
        return response({
          ok: true,
          quoteFingerprint: "quote_paypal",
          quote: { grossAmount: 10, netAmount: 10, isFree: false },
        });
      }
      if (url === "/api/payment/start") {
        return response({
          ok: true,
          quoteFingerprint: "quote_paypal",
          paymentAccessToken: "payment_access_paypal",
          providerPayload: {
            orderId: "paypal_order_1",
            currency: "USD",
            clientId: "test-client",
          },
        });
      }
      if (url === "/api/payment/finalize") {
        return response({
          ok: true,
          bookingId: "booking_paypal",
          status: "booked",
          emailDispatchToken: "dispatch_paypal",
        });
      }
      return response({ ok: true });
    });

    renderPayment(bookingFixture());
    await waitFor(() => expect(paypalButtonsProps?.disabled).toBe(false));
    const paypalShell = screen
      .getByRole("button", { name: "PayPal Buttons" })
      .closest(".paypal-checkout-shell");
    expect(paypalShell).toHaveClass("overflow-hidden", "rounded-lg");
    expect(paypalShell.className).toContain("[&_iframe]:!border-0");
    expect(
      screen.getByRole("link", { name: /back to booking/i }).closest("section")
    ).toHaveClass("py-4");

    const clientCreate = jest.fn();
    let orderId;
    await act(async () => {
      orderId = await paypalButtonsProps.createOrder(
        {},
        { order: { create: clientCreate } }
      );
    });
    expect(orderId).toBe("paypal_order_1");
    expect(clientCreate).not.toHaveBeenCalled();

    await act(async () => {
      await paypalButtonsProps.onApprove(
        { orderID: "paypal_order_1" },
        {
          order: {
            capture: jest.fn().mockResolvedValue({
              id: "paypal_order_1",
              payer: { email_address: "payer@example.com" },
            }),
          },
        }
      );
    });

    const finalize = fetchCalls.find(
      (call) => call.url === "/api/payment/finalize"
    );
    expect(finalize.options.headers.Authorization).toBe(
      "Bearer payment_access_paypal"
    );
    expect(finalize.body.providerData.paypalOrderId).toBe("paypal_order_1");
  });

  test("a concurrent finalizer is polled by bearer token without putting the token in the URL", async () => {
    const fetchCalls = [];
    let statusReads = 0;
    global.fetch = jest.fn(async (url, options = {}) => {
      fetchCalls.push({ url, options });
      if (url === "/api/payment/providers") {
        return response({
          ok: true,
          providers: {
            razorpay: { enabled: true, mode: "live" },
            paypal: { enabled: true, mode: "live", clientId: "test-client" },
          },
        });
      }
      if (url === "/api/payment/quote") {
        return response({
          ok: true,
          quoteFingerprint: "quote_poll",
          quote: { grossAmount: 10, netAmount: 10, isFree: false },
        });
      }
      if (url === "/api/payment/start") {
        return response({
          ok: true,
          quoteFingerprint: "quote_poll",
          paymentAccessToken: "private_poll_token",
          providerPayload: { orderId: "paypal_order_poll" },
        });
      }
      if (url === "/api/payment/finalize") {
        return response(
          { ok: true, status: "finalizing" },
          { ok: false, status: 202 }
        );
      }
      if (url === "/api/payment/status") {
        statusReads += 1;
        return response({
          ok: true,
          status: "booked",
          bookingId: "booking_poll",
          emailDispatchToken: "dispatch_poll",
        });
      }
      return response({ ok: true });
    });

    renderPayment(bookingFixture());
    await waitFor(() => expect(paypalButtonsProps?.disabled).toBe(false));
    await act(async () => {
      await paypalButtonsProps.createOrder({}, {});
      await paypalButtonsProps.onApprove(
        { orderID: "paypal_order_poll" },
        {
          order: {
            capture: jest.fn().mockResolvedValue({ id: "paypal_order_poll" }),
          },
        }
      );
    });

    expect(statusReads).toBe(1);
    const statusCall = fetchCalls.find((call) => call.url === "/api/payment/status");
    expect(statusCall.options.method).toBe("POST");
    expect(statusCall.options.headers.Authorization).toBe(
      "Bearer private_poll_token"
    );
    expect(
      fetchCalls.some((call) => String(call.url).includes("private_poll_token"))
    ).toBe(false);
  });

  test("reload resumes the same provider session and keeps the other provider disabled", async () => {
    let starts = 0;
    global.fetch = jest.fn(async (url) => {
      if (url === "/api/payment/providers") {
        return response({
          ok: true,
          providers: {
            razorpay: { enabled: true, mode: "live" },
            paypal: { enabled: true, mode: "live", clientId: "test-client" },
          },
        });
      }
      if (url === "/api/payment/quote") {
        return response({
          ok: true,
          quoteFingerprint: "quote_resume",
          quote: { grossAmount: 10, netAmount: 10, isFree: false },
        });
      }
      if (url === "/api/payment/start") {
        starts += 1;
        return response({
          ok: true,
          quoteFingerprint: "quote_resume",
          paymentAccessToken: "resume_access",
          providerPayload: { orderId: "paypal_order_resume" },
        });
      }
      return response({ ok: true });
    });

    const first = renderPayment(bookingFixture());
    await waitFor(() => expect(paypalButtonsProps?.disabled).toBe(false));
    await act(async () => {
      expect(await paypalButtonsProps.createOrder({}, {})).toBe(
        "paypal_order_resume"
      );
    });
    expect(starts).toBe(1);
    first.unmount();

    renderPayment(bookingFixture());
    const razorpayButton = await screen.findByRole("button", {
      name: /pay with razorpay/i,
    });
    await waitFor(() => expect(razorpayButton).toBeDisabled());
    await waitFor(() => expect(paypalButtonsProps?.disabled).toBe(false));
    await act(async () => {
      expect(await paypalButtonsProps.createOrder({}, {})).toBe(
        "paypal_order_resume"
      );
    });
    expect(starts).toBe(1);
    expect(screen.getByText(/pricing and provider selection are locked/i)).toBeInTheDocument();
  });

  test("reload checks server status before reusing a completed provider order", async () => {
    let starts = 0;
    global.fetch = jest.fn(async (url) => {
      if (url === "/api/payment/providers") {
        return response({
          ok: true,
          providers: {
            razorpay: { enabled: false, mode: "live" },
            paypal: { enabled: true, mode: "live", clientId: "test-client" },
          },
        });
      }
      if (url === "/api/payment/quote") {
        return response({
          ok: true,
          quoteFingerprint: "quote_completed_resume",
          quote: { grossAmount: 10, netAmount: 10, isFree: false },
        });
      }
      if (url === "/api/payment/start") {
        starts += 1;
        return response({
          ok: true,
          status: "started",
          quoteFingerprint: "quote_completed_resume",
          paymentAccessToken: "completed_resume_access",
          providerPayload: { orderId: "paypal_completed_resume" },
        });
      }
      if (url === "/api/payment/status") {
        return response({
          ok: true,
          status: "booked",
          bookingId: "booking_completed_resume",
        });
      }
      return response({ ok: true });
    });

    const first = renderPayment(bookingFixture());
    await waitFor(() => expect(paypalButtonsProps?.disabled).toBe(false));
    await act(async () => {
      expect(await paypalButtonsProps.createOrder({}, {})).toBe(
        "paypal_completed_resume"
      );
    });
    first.unmount();

    renderPayment(bookingFixture());
    await waitFor(() => expect(paypalButtonsProps?.disabled).toBe(false));
    await act(async () => {
      await expect(paypalButtonsProps.createOrder({}, {})).rejects.toThrow(
        /already complete/i
      );
    });

    expect(starts).toBe(1);
    expect(mockNavigate).toHaveBeenCalledWith(
      "/payment-success",
      expect.objectContaining({ replace: true })
    );
  });

  test("quote changes never create an order until the customer retries", async () => {
    let startAttempts = 0;
    global.fetch = jest.fn(async (url) => {
      if (url === "/api/payment/providers") {
        return response({
          ok: true,
          providers: {
            razorpay: { enabled: true, mode: "live" },
            paypal: { enabled: false, mode: "live" },
          },
        });
      }
      if (url === "/api/payment/quote") {
        return response({
          ok: true,
          quoteFingerprint: "quote_old",
          quote: { grossAmount: 10, netAmount: 10, isFree: false },
        });
      }
      if (url === "/api/payment/start") {
        startAttempts += 1;
        return response(
          {
            ok: false,
            code: "quote_changed",
            error: "Quote changed",
            quoteFingerprint: "quote_new",
            quote: { grossAmount: 12, netAmount: 12, isFree: false },
          },
          { ok: false, status: 409 }
        );
      }
      return response({ ok: true });
    });

    window.Razorpay = jest.fn();
    renderPayment(bookingFixture());
    await loadRazorpay();
    const button = await screen.findByRole("button", { name: /pay with razorpay/i });
    await waitFor(() => expect(button).not.toBeDisabled());
    await userEvent.click(button);

    await screen.findByText(/price changed/i);
    expect(startAttempts).toBe(1);
    expect(window.Razorpay).not.toHaveBeenCalled();
    expect(screen.getByText("$12.00 USD")).toBeInTheDocument();
  });

  test("a collision entered as a coupon resolves to a free referral and finalizes", async () => {
    const fetchCalls = [];
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = jest.fn(async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      fetchCalls.push({ url, body });
      if (url === "/api/payment/providers") {
        return response({ ok: true, providers: {} });
      }
      if (String(url).startsWith("/api/ref/validateReferral")) {
        return response({
          ok: true,
          referral: {
            _id: "referral.creatorfree",
            name: "Private Creator Name",
            currentCommissionPercent: 25,
            code: "creatorfree",
            currentDiscountPercent: 100,
          },
        });
      }
      if (String(url).startsWith("/api/ref/validateCoupon")) {
        return response({
          ok: true,
          coupon: {
            id: "coupon.creatorfree",
            title: "Internal coupon title",
            code: "CREATORFREE",
            discountType: "fixed",
            discountAmount: 54.95,
            canCombineWithReferral: true,
          },
        });
      }
      if (url === "/api/payment/quote") {
        const free = body.referralCode === "creatorfree";
        return response({
          ok: true,
          quoteFingerprint: free ? "quote_free" : "quote_paid",
          quote: {
            grossAmount: 54.95,
            discountAmount: free ? 54.95 : 0,
            netAmount: free ? 0 : 54.95,
            isFree: free,
          },
        });
      }
      if (url === "/api/payment/start") {
        return response({
          ok: true,
          provider: "free",
          status: "booked",
          bookingId: "booking_free",
          emailDispatchToken: "dispatch_free",
          paymentAccessToken: "free_access",
        });
      }
      return response({ ok: true });
    });

    renderPayment(bookingFixture({ packagePrice: "$54.95" }));
    const couponInput = screen.getByPlaceholderText(/e\.g\. BF10/i);
    await waitFor(() => expect(couponInput).not.toBeDisabled());
    await userEvent.type(
      couponInput,
      "CREATORFREE"
    );
    const applyButtons = screen.getAllByRole("button", { name: /apply/i });
    await userEvent.click(applyButtons[1]);

    expect(
      await screen.findByText(
        "This code is a referral, so it was applied as a referral."
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/creatorfree · −\$/))
      .toBeInTheDocument();
    expect(screen.queryByText(/Private Creator Name/i)).not.toBeInTheDocument();
    expect(await screen.findByText("$0.00 USD")).toBeInTheDocument();
    expect(couponInput).toHaveValue("");

    const freeButton = await screen.findByRole("button", {
      name: /confirm free booking/i,
    });
    await waitFor(() => expect(freeButton).not.toBeDisabled());
    await act(async () => {
      await userEvent.click(freeButton);
    });

    const start = fetchCalls.find(
      (call) => call.url === "/api/payment/start" && call.body.provider === "free"
    );
    expect(start.body.quoteFingerprint).toBe("quote_free");
    expect(start.body.bookingPayload).toMatchObject({
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$54.95",
      referralCode: "creatorfree",
      couponCode: "",
    });
    expect(start.body.bookingPayload).not.toHaveProperty("referralId");
    const finalQuote = fetchCalls
      .filter((call) => call.url === "/api/payment/quote")
      .at(-1);
    expect(finalQuote.body).toMatchObject({
      referralCode: "creatorfree",
      couponCode: "",
    });
    expect(fetchCalls.some((call) => call.url === "/api/ref/createBooking")).toBe(
      false
    );
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith("/thank-you", {
        state: {
          bookingConfirmation: {
            bookingId: "booking_free",
            emailDispatchToken: "dispatch_free",
          },
        },
        replace: true,
      })
    );
    expect(warn).toHaveBeenCalledWith(
      "checkout_code_namespace_collision",
      expect.objectContaining({
        code: "creatorfree",
        precedence: "referral_first",
      })
    );
    warn.mockRestore();
  });

  test("a BookingForm referral payload is validated, quoted, and sent to payment start", async () => {
    const fetchCalls = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      const requestUrl = String(url);
      const body = JSON.parse(options.body || "{}");
      fetchCalls.push({ url: requestUrl, body });
      if (requestUrl === "/api/payment/providers") {
        return response({ ok: true, providers: {} });
      }
      if (requestUrl.startsWith("/api/ref/validateReferral")) {
        return response({
          ok: true,
          referral: {
            code: "bookingfree",
            currentDiscountPercent: 100,
            name: "Private Creator Name",
            currentCommissionPercent: 25,
          },
        });
      }
      if (requestUrl.startsWith("/api/ref/validateCoupon")) {
        return response(
          { ok: false, error: "Coupon not found", reason: "not_found" },
          { ok: true, status: 200 }
        );
      }
      if (requestUrl === "/api/payment/quote") {
        const free = body.referralCode === "bookingfree";
        return response({
          ok: true,
          quoteFingerprint: "booking-referral-free-quote",
          quote: {
            grossAmount: 54.95,
            discountAmount: free ? 54.95 : 0,
            netAmount: free ? 0 : 54.95,
            isFree: free,
          },
        });
      }
      if (requestUrl === "/api/payment/start") {
        return response({
          ok: true,
          provider: "free",
          status: "booked",
          bookingId: "booking_referral_free",
          emailDispatchToken: "dispatch_referral_free",
        });
      }
      return response({ ok: true });
    });

    renderPayment(
      bookingFixture({
        packagePrice: "$54.95",
        referralCode: "bookingfree",
      })
    );

    expect(await screen.findByText(/bookingfree · −\$54\.95/))
      .toBeInTheDocument();
    expect(screen.getByText("$0.00 USD")).toBeInTheDocument();
    expect(screen.queryByText(/Private Creator Name/i)).not.toBeInTheDocument();
    const freeButton = await screen.findByRole("button", {
      name: /confirm free booking/i,
    });
    await waitFor(() => expect(freeButton).not.toBeDisabled());
    await act(async () => userEvent.click(freeButton));

    const quote = fetchCalls
      .filter((call) => call.url === "/api/payment/quote")
      .at(-1);
    const start = fetchCalls.find((call) => call.url === "/api/payment/start");
    expect(quote.body).toMatchObject({
      packageTitle: "Performance Vertex Overhaul",
      referralCode: "bookingfree",
      couponCode: "",
    });
    expect(start.body).toMatchObject({
      provider: "free",
      quoteFingerprint: "booking-referral-free-quote",
      bookingPayload: {
        packageTitle: "Performance Vertex Overhaul",
        packagePrice: "$54.95",
        referralCode: "bookingfree",
        couponCode: "",
      },
    });
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        "/thank-you",
        expect.objectContaining({ replace: true })
      )
    );
  });

  test("does not apply a code when the slot hold expires during validation", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2099-01-15T08:00:00.000Z"));
    const fetchCalls = [];
    let releaseReferral;
    let markValidationStarted;
    const validationStarted = new Promise((resolve) => {
      markValidationStarted = resolve;
    });
    global.fetch = jest.fn(async (url, options = {}) => {
      const requestUrl = String(url);
      const body = JSON.parse(options.body || "{}");
      fetchCalls.push({ url: requestUrl, body });
      if (requestUrl === "/api/payment/providers") {
        return response({ ok: true, providers: {} });
      }
      if (requestUrl.startsWith("/api/ref/validateReferral")) {
        markValidationStarted();
        return new Promise((resolve) => {
          releaseReferral = () =>
            resolve(
              response({
                ok: true,
                referral: {
                  code: "racecreator",
                  currentDiscountPercent: 10,
                },
              })
            );
        });
      }
      if (requestUrl.startsWith("/api/ref/validateCoupon")) {
        return response(
          { ok: false, error: "Coupon not found", reason: "not_found" },
          { ok: true, status: 200 }
        );
      }
      if (requestUrl === "/api/payment/quote") {
        return response({
          ok: true,
          quoteFingerprint: "hold-expired-quote",
          quote: { grossAmount: 54.95, netAmount: 54.95, isFree: false },
        });
      }
      return response({ ok: true });
    });

    renderPayment(
      bookingFixture({
        packagePrice: "$54.95",
        referralCode: "racecreator",
        slotHoldExpiresAt: "2099-01-15T08:00:01.000Z",
      })
    );
    await act(async () => validationStarted);
    expect(releaseReferral).toEqual(expect.any(Function));

    act(() => jest.advanceTimersByTime(1001));
    await act(async () => releaseReferral());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockNavigate).toHaveBeenCalledWith(
      "/booking",
      expect.objectContaining({ replace: true })
    );
    expect(screen.queryByText(/racecreator/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. vouch")).toHaveValue("");
    const quoteCalls = fetchCalls.filter(
      (call) => call.url === "/api/payment/quote"
    );
    quoteCalls.forEach((call) => {
      expect(call.body.referralCode).toBe("");
      expect(call.body.couponCode).toBe("");
    });
  });

  test("legacy query payload is scrubbed immediately and never enables legacy flow", async () => {
    const bookingData = bookingFixture();
    const encoded = encodeURIComponent(JSON.stringify(bookingData));
    global.fetch = jest.fn(async (url) => {
      if (url === "/api/payment/quote") {
        return response({
          ok: true,
          quoteFingerprint: "quote_legacy",
          quote: { grossAmount: 10, netAmount: 10, isFree: false },
        });
      }
      if (url === "/api/payment/providers") {
        return response({ ok: true, providers: {} });
      }
      return response({ ok: true });
    });

    __setMockLocation({
      pathname: "/payment",
      search: `?data=${encoded}&paymentFlow=legacy`,
      hash: "",
      state: null,
    });
    render(<Payment />);

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        { pathname: "/payment", search: "", hash: "" },
        { replace: true, state: {} }
      )
    );
    expect(screen.queryByText("Performance Vertex Overhaul")).not.toBeInTheDocument();
    expect(
      screen.getByText(/price confirmation is unavailable/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/legacy/i)).not.toBeInTheDocument();
  });
});
