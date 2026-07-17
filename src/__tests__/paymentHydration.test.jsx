import React from "react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Payment from "../components/Payment";

jest.mock("framer-motion", () => ({
  motion: new Proxy({}, { get: () => "div" }),
}));

jest.mock("@paypal/react-paypal-js", () => ({
  PayPalButtons: () => <button type="button">PayPal</button>,
  PayPalScriptProvider: ({ children }) => <>{children}</>,
}));

const checkout = {
  packageTitle: "Performance Vertex Max",
  packagePrice: "$99.95",
  email: "qa@example.invalid",
  displayDate: "Friday, July 17, 2026",
  displayTime: "8:00 AM",
  localTimeZone: "Asia/Calcutta",
  startTimeUTC: "2026-07-17T02:30:00.000Z",
  slotHoldId: "slotHold.qa",
  slotHoldToken: "qa.token",
  slotHoldExpiresAt: "2099-01-01T00:00:00.000Z",
};
const checkoutFingerprint = JSON.stringify({
  packageTitle: checkout.packageTitle,
  originalOrderId: "",
  startTimeUTC: checkout.startTimeUTC,
  email: checkout.email,
  referralCode: "locked-referral",
  couponCode: "LOCKED10",
});
const paymentSession = {
  provider: "razorpay",
  fingerprint: checkoutFingerprint,
  paymentAccessToken: "payment-access-token",
  providerPayload: {
    orderId: "order_hydration",
    amount: 9995,
    currency: "USD",
    key: "rzp_live_public_id",
  },
};

const tree = (
  <MemoryRouter initialEntries={["/payment"]}>
    <Payment hideFooter />
  </MemoryRouter>
);

describe("payment reload hydration", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test("restores tab-scoped checkout state after hydration without changing the first render", async () => {
    const timeZoneSpy = jest
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ timeZone: "UTC" });
    window.sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
    window.sessionStorage.setItem(
      "payment_session_state",
      JSON.stringify(paymentSession)
    );
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      json: async () =>
        String(url).includes("/quote")
          ? {
              ok: true,
              quoteFingerprint: "quote-fingerprint",
              quote: { grossAmount: 99.95, netAmount: 99.95, isFree: false },
              providers: {
                razorpay: { enabled: false },
                paypal: { enabled: false, clientId: "" },
              },
            }
          : {
              ok: true,
              providers: {
                razorpay: { enabled: false },
                paypal: { enabled: false, clientId: "" },
              },
            },
    }));

    const markup = renderToString(tree);
    timeZoneSpy.mockReturnValue({ timeZone: "Asia/Calcutta" });
    const container = document.createElement("div");
    container.innerHTML = markup;
    document.body.appendChild(container);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let root;

    await act(async () => {
      root = hydrateRoot(container, tree);
      await Promise.resolve();
    });

    const hydrationErrors = errorSpy.mock.calls.filter((args) =>
      args.some((value) => /hydration|did not match|minified react error #418/i.test(String(value)))
    );
    expect(hydrationErrors).toEqual([]);
    expect(container.textContent).toContain("Performance Vertex Max");
    expect(
      JSON.parse(window.sessionStorage.getItem("payment_session_state"))
    ).toMatchObject({
      provider: "razorpay",
      paymentAccessToken: "payment-access-token",
    });
    expect(container.querySelector('input[placeholder="e.g. vouch"]')).toHaveValue(
      "locked-referral"
    );
    expect(container.querySelector('input[placeholder="e.g. BF10"]')).toHaveValue(
      "LOCKED10"
    );

    await act(async () => root.unmount());
    errorSpy.mockRestore();
    timeZoneSpy.mockRestore();
    container.remove();
  });

  test("validates booking payload codes into the payment inputs on arrival", async () => {
    const bookingData = {
      ...checkout,
      referralCode: "creator",
      couponCode: "SAVE10",
    };
    const quotePayloads = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith("/api/ref/validateReferral")) {
        const code = new URL(requestUrl, "https://rooindustries.com")
          .searchParams.get("code")
          ?.toLowerCase();
        if (code !== "creator") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: false,
              error: "Not found",
              reason: "not_found",
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            referral: {
              _id: "referral.creator",
              name: "Private Creator Name",
              currentCommissionPercent: 25,
              code: "creator",
              currentDiscountPercent: 10,
            },
          }),
        };
      }
      if (requestUrl.startsWith("/api/ref/validateCoupon")) {
        const code = new URL(requestUrl, "https://rooindustries.com")
          .searchParams.get("code")
          ?.toLowerCase();
        if (code !== "save10") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: false,
              error: "Coupon not found",
              reason: "not_found",
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            coupon: {
              id: "coupon.save10",
              code: "SAVE10",
              discountType: "fixed",
              discountAmount: 10,
              canCombineWithReferral: true,
            },
          }),
        };
      }
      if (requestUrl === "/api/payment/quote") {
        quotePayloads.push(JSON.parse(options.body || "{}"));
        return {
          ok: true,
          json: async () => ({
            ok: true,
            quoteFingerprint: "prefilled-quote",
            quote: { grossAmount: 99.95, netAmount: 80.95, isFree: false },
            providers: {
              razorpay: { enabled: false },
              paypal: { enabled: false, clientId: "" },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          providers: {
            razorpay: { enabled: false },
            paypal: { enabled: false, clientId: "" },
          },
        }),
      };
    });

    render(
      <MemoryRouter
        initialEntries={[{ pathname: "/payment", state: { bookingData } }]}
      >
        <Payment hideFooter />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. vouch")).toHaveValue("creator");
      expect(screen.getByPlaceholderText("e.g. BF10")).toHaveValue("SAVE10");
    });
    expect(await screen.findByText("$80.95 USD")).toBeInTheDocument();
    expect(screen.getByText(/creator · −\$/)).toBeInTheDocument();
    expect(screen.queryByText(/Private Creator Name/i)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/ref/validateReferral?code=creator"
      );
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/ref/validateCoupon?code=SAVE10")
      );
    });
    expect(quotePayloads.at(-1)).toMatchObject({
      packageTitle: "Performance Vertex Max",
      referralCode: "creator",
      couponCode: "SAVE10",
    });
    expect(quotePayloads.at(-1)).not.toHaveProperty("referralId");
  });

  test("drops an expired restored coupon before requesting a quote", async () => {
    const bookingData = {
      ...checkout,
      couponCode: "EXPIRED",
    };
    const quotePayloads = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith("/api/ref/validateReferral")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: false,
            error: "Not found",
            reason: "not_found",
          }),
        };
      }
      if (requestUrl.startsWith("/api/ref/validateCoupon")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            ok: false,
            error: "This coupon has expired.",
          }),
        };
      }
      if (requestUrl === "/api/payment/quote") {
        quotePayloads.push(JSON.parse(options.body || "{}"));
        return {
          ok: true,
          json: async () => ({
            ok: true,
            quoteFingerprint: "expired-code-removed",
            quote: { grossAmount: 99.95, netAmount: 99.95, isFree: false },
            providers: {},
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, providers: {} }),
      };
    });

    render(
      <MemoryRouter
        initialEntries={[{ pathname: "/payment", state: { bookingData } }]}
      >
        <Payment hideFooter />
      </MemoryRouter>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This coupon has expired."
    );
    expect(screen.getByPlaceholderText("e.g. BF10")).toHaveValue("");
    await waitFor(() => expect(quotePayloads).toHaveLength(1));
    expect(quotePayloads[0]).toMatchObject({
      referralCode: "",
      couponCode: "",
    });
    expect(await screen.findByText("$99.95 USD")).toBeInTheDocument();
  });

  test("pre-applies referral then checks coupon stacking against that fresh result", async () => {
    const bookingData = {
      ...checkout,
      referralCode: "creator",
      couponCode: "SAVE10",
    };
    const requestedUrls = [];
    const quotePayloads = [];
    let releaseReferral;
    global.fetch = jest.fn(async (url, options = {}) => {
      const requestUrl = String(url);
      requestedUrls.push(requestUrl);
      if (requestUrl.startsWith("/api/ref/validateReferral")) {
        const code = new URL(requestUrl, "https://rooindustries.com")
          .searchParams.get("code")
          ?.toLowerCase();
        if (code === "creator") {
          return new Promise((resolve) => {
            releaseReferral = () =>
              resolve({
                ok: true,
                json: async () => ({
                  ok: true,
                  referral: {
                    code: "creator",
                    currentDiscountPercent: 10,
                  },
                }),
              });
          });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: false,
            error: "Not found",
            reason: "not_found",
          }),
        };
      }
      if (requestUrl.startsWith("/api/ref/validateCoupon")) {
        const code = new URL(requestUrl, "https://rooindustries.com")
          .searchParams.get("code")
          ?.toLowerCase();
        return code === "save10"
          ? {
              ok: true,
              json: async () => ({
                ok: true,
                coupon: {
                  code: "SAVE10",
                  discountType: "fixed",
                  discountAmount: 10,
                  canCombineWithReferral: false,
                },
              }),
            }
          : {
              ok: true,
              status: 200,
              json: async () => ({
                ok: false,
                error: "Coupon not found",
                reason: "not_found",
              }),
            };
      }
      if (requestUrl === "/api/payment/quote") {
        quotePayloads.push(JSON.parse(options.body || "{}"));
        return {
          ok: true,
          json: async () => ({
            ok: true,
            quoteFingerprint: "sequential-stack-quote",
            quote: { grossAmount: 99.95, netAmount: 89.95, isFree: false },
            providers: {},
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, providers: {} }),
      };
    });

    render(
      <MemoryRouter
        initialEntries={[{ pathname: "/payment", state: { bookingData } }]}
      >
        <Payment hideFooter />
      </MemoryRouter>
    );

    await waitFor(() => expect(releaseReferral).toEqual(expect.any(Function)));
    expect(requestedUrls.some((url) => url.includes("code=SAVE10"))).toBe(false);
    await act(async () => releaseReferral());
    await waitFor(() =>
      expect(requestedUrls.some((url) => url.includes("code=SAVE10"))).toBe(true)
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This coupon can't be used together with a referral discount."
    );
    expect(screen.getByPlaceholderText("e.g. vouch")).toHaveValue("creator");
    expect(screen.getByPlaceholderText("e.g. BF10")).toHaveValue("");
    await waitFor(() => expect(quotePayloads).toHaveLength(1));
    expect(quotePayloads[0]).toMatchObject({
      referralCode: "creator",
      couponCode: "",
    });
  });
});
