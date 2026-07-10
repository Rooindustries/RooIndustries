import React from "react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
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

const tree = (
  <MemoryRouter initialEntries={["/payment"]}>
    <Payment hideFooter />
  </MemoryRouter>
);

describe("payment reload hydration", () => {
  test("restores tab-scoped checkout state after hydration without changing the first render", async () => {
    const timeZoneSpy = jest
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ timeZone: "UTC" });
    window.sessionStorage.setItem("checkout_booking_state", JSON.stringify(checkout));
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

    await act(async () => root.unmount());
    errorSpy.mockRestore();
    timeZoneSpy.mockRestore();
    container.remove();
  });
});
