import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BookingForm from "../components/BookingForm";

let mockLocation = {
  pathname: "/booking",
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

const CLIENT_EMAIL = "vihaann2.0@gmail.com";
const OWNER_EMAIL = "serviroo@rooindustries.com";
const OWNER_TZ = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330;

const getUtcFromHostLocal = (year, monthIndex, day, hostHour) => {
  const utcMs =
    Date.UTC(year, monthIndex, day, hostHour, 0) -
    IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcMs);
};

const formatLocalTime = (utcDate, timeZone) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(utcDate);

describe("booking calendar UI", () => {
  let resolvedOptionsSpy;

  beforeEach(() => {
    mockNavigate.mockReset();
    window.sessionStorage.clear();
    window.localStorage.clear();
    resolvedOptionsSpy = jest
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ timeZone: "America/Los_Angeles" });
  });

  afterEach(() => {
    if (global.fetch && global.fetch.mockReset) {
      global.fetch.mockReset();
    }
    if (resolvedOptionsSpy) {
      resolvedOptionsSpy.mockRestore();
    }
  });

  test("shows client-local times only and uses the fixed client email", async () => {
    expect(CLIENT_EMAIL).toBe("vihaann2.0@gmail.com");
    expect(OWNER_EMAIL).toBe("serviroo@rooindustries.com");

    const settings = {
      dateSlots: [{ date: "2099-01-05", times: ["10:00"] }],
      xocDateSlots: [],
      vertexEssentialsDateSlots: [],
      packageDateSlots: [],
    };

    let holdRequestBody = null;
    global.fetch = jest.fn(async (url, options = {}) => {
      if (url === "/api/bookingAvailability") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            settings,
            bookedSlots: [],
          }),
        };
      }
      if (url === "/api/holdSlot") {
        holdRequestBody = JSON.parse(options.body || "{}");
        return {
          ok: true,
          json: async () => ({
            ok: true,
            holdId: "hold_ui_1",
            holdToken: "hold_token_ui_1",
            expiresAt: "2099-01-05T06:00:00.000Z",
          }),
        };
      }
      if (url === "/api/releaseHold") {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    __setMockLocation({
      pathname: "/booking",
      search: "",
      state: {
        bookingPackage: {
          title: "Performance Vertex Overhaul",
          price: "$84.99",
          tag: "Test",
        },
      },
    });

    render(<BookingForm />);

    const userTimeZone = "America/Los_Angeles";
    const utcStart = getUtcFromHostLocal(2099, 0, 5, 10);
    const expectedLocalLabel = formatLocalTime(utcStart, userTimeZone);

    const timeSlotButton = await screen.findByRole("button", {
      name: expectedLocalLabel,
    });

    expect(timeSlotButton).toBeInTheDocument();
    const helperText = screen.getByText(/times are shown in/i);
    expect(helperText.textContent).toContain(userTimeZone);

    expect(document.body.textContent).not.toContain(OWNER_TZ);
    expect(document.body.textContent).not.toContain("UTC");

    await userEvent.click(timeSlotButton);
    const nextButton = screen.getByRole("button", { name: /next/i });
    await userEvent.click(nextButton);

    const emailInput = await screen.findByPlaceholderText("Email");
    await userEvent.type(emailInput, CLIENT_EMAIL);
    expect(emailInput).toHaveValue(CLIENT_EMAIL);

    expect(holdRequestBody).toBeTruthy();
    expect(holdRequestBody.hostDate).toBeUndefined();
    expect(holdRequestBody.hostTime).toBeUndefined();
    expect(holdRequestBody.hostTimeZone).toBeUndefined();
  });

  test("payment-pending booking shows one release action and one return action", async () => {
    const expiresAt = "2099-01-05T06:00:00.000Z";
    window.sessionStorage.setItem(
      "my_slot_hold",
      JSON.stringify({
        holdId: "hold_pending_1",
        holdToken: "hold_token_pending_1",
        expiresAt,
        startTimeUTC: "2099-01-05T04:30:00.000Z",
        packageTitle: "Performance Vertex Overhaul",
        packagePrice: "$84.99",
        phase: "payment_pending",
      })
    );
    window.sessionStorage.setItem(
      "payment_session_state",
      JSON.stringify({ paymentAccessToken: "payment_access_pending_1" })
    );
    window.sessionStorage.setItem(
      "checkout_booking_state",
      JSON.stringify({
        packageTitle: "Performance Vertex Overhaul",
        packagePrice: "$84.99",
        startTimeUTC: "2099-01-05T04:30:00.000Z",
        slotHoldId: "hold_pending_1",
        slotHoldToken: "hold_token_pending_1",
        slotHoldExpiresAt: expiresAt,
      })
    );
    window.sessionStorage.setItem(
      "booking_modal_state",
      JSON.stringify({
        packageTitle: "Performance Vertex Overhaul",
        step: 2,
        selectedSlot: {
          slotId: "2099-01-05T04:30:00.000Z",
          utcStart: "2099-01-05T04:30:00.000Z",
          localLabel: "8:30 PM",
        },
      })
    );

    global.fetch = jest.fn(async (url, options = {}) => {
      if (String(url).startsWith("/api/content/package")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              title: "Performance Vertex Overhaul",
              price: "$84.99",
            },
          }),
        };
      }
      if (url === "/api/bookingAvailability") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            settings: { dateSlots: [] },
            bookedSlots: [],
          }),
        };
      }
      if (url === "/api/payment/cancel") {
        expect(options.headers.Authorization).toBe(
          "Bearer payment_access_pending_1"
        );
        return {
          ok: true,
          json: async () => ({
            ok: true,
            cancelled: true,
            refreshedHold: {
              slotHoldId: "hold_pending_1",
              slotHoldToken: "hold_token_refreshed_1",
              slotHoldExpiresAt: expiresAt,
              phase: "holding",
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    __setMockLocation({
      pathname: "/booking",
      search: "",
      state: {
        bookingPackage: {
          title: "Performance Vertex Overhaul",
          price: "$84.99",
          tag: "Test",
        },
      },
    });
    render(<BookingForm />);

    const releaseButton = await screen.findByRole("button", {
      name: /^release payment$/i,
    });
    expect(
      screen.getAllByRole("button", { name: /^return to payment$/i })
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^back$/i })).not.toBeInTheDocument();
    expect(releaseButton.parentElement).toHaveClass("grid", "sm:grid-cols-2");

    await userEvent.click(
      screen.getByRole("button", { name: /^return to payment$/i })
    );
    expect(mockNavigate).toHaveBeenCalledWith("/payment", {
      state: {
        bookingData: expect.objectContaining({
          slotHoldToken: "hold_token_pending_1",
        }),
      },
    });
    mockNavigate.mockClear();

    await userEvent.click(releaseButton);

    expect(
      await screen.findByText(/payment method released/i)
    ).toBeInTheDocument();
    expect(window.sessionStorage.getItem("payment_session_state")).toBeNull();
    expect(
      JSON.parse(window.sessionStorage.getItem("my_slot_hold"))
    ).toMatchObject({
      holdToken: "hold_token_refreshed_1",
      phase: "holding",
    });
    expect(
      JSON.parse(window.sessionStorage.getItem("checkout_booking_state"))
    ).toMatchObject({
      slotHoldToken: "hold_token_refreshed_1",
      slotHoldExpiresAt: expiresAt,
    });
  });

  test("restores the selected package after a clean-URL refresh", async () => {
    window.sessionStorage.setItem(
      "booking_draft",
      JSON.stringify({
        lastTitle: "Vertex Essentials",
        packages: {
          "Vertex Essentials": {
            selectedPackage: {
              title: "Vertex Essentials",
              price: "$29.95",
              tag: "The Perfect Starting Point",
            },
          },
        },
      })
    );
    global.fetch = jest.fn(async (url) => {
      if (String(url).startsWith("/api/content/package")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              title: "Vertex Essentials",
              price: "$29.95",
              tag: "The Perfect Starting Point",
            },
          }),
        };
      }
      if (url === "/api/bookingAvailability") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            settings: { dateSlots: [] },
            bookedSlots: [],
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    __setMockLocation({
      pathname: "/booking",
      search: "",
      state: null,
    });

    render(<BookingForm />);

    expect(await screen.findByText("Vertex Essentials")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /submit & pay/i })
    ).not.toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(
        window.sessionStorage.getItem("booking_draft")
      );
      expect(
        stored.packages["Vertex Essentials"].selectedPackage.title
      ).toBe("Vertex Essentials");
    });
  });
});
