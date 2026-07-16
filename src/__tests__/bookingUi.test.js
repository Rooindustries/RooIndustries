import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BookingForm from "../components/BookingForm";
import { calculateCheckoutDiscounts } from "../lib/checkoutCodes";

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
const REASSURANCE_COPY =
  "You won't be charged until you confirm on the payment page.";
const PAYMENT_PENDING_EXPIRY_ERROR =
  "This reservation expired while payment is still pending. Return to payment to check its status or release payment to try again.";

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

const OVERHAUL_PACKAGE = {
  title: "Performance Vertex Overhaul",
  price: "$54.95",
  tag: "Test",
};
const MAX_PACKAGE = {
  title: "Performance Vertex Max",
  price: "$99.95",
  tag: "Test",
};
const FUTURE_SLOT = "2099-01-05T04:30:00.000Z";
const FUTURE_EXPIRY = "2099-01-05T06:00:00.000Z";
const VALID_FORM = {
  discord: "LatencyTester",
  email: CLIENT_EMAIL,
  specs: "Ryzen 9 9950X3D, RTX 5090",
  mainGame: "Valorant",
  notes: "Keep fan noise low",
};
const CREATOR_REFERRAL = {
  _id: "referral.creator",
  name: "Private Creator Name",
  currentCommissionPercent: 25,
  code: "creator",
  currentDiscountPercent: 10,
};
const FIXED_COUPON = {
  id: "coupon.save10",
  title: "Internal coupon title",
  code: "SAVE10",
  discountType: "fixed",
  discountAmount: 10,
  discountPercent: 0,
  canCombineWithReferral: true,
  timesUsed: 4,
};
const STACKING_COUPON = {
  id: "coupon.club5",
  code: "CLUB5",
  discountType: "percent",
  discountPercent: 5,
  discountAmount: null,
  canCombineWithReferral: true,
};

const setBookingLocation = (bookingPackage = OVERHAUL_PACKAGE, search = "") => {
  __setMockLocation({
    pathname: "/booking",
    search,
    hash: "",
    state: { bookingPackage },
  });
};

const seedBookingSession = ({
  bookingPackage = OVERHAUL_PACKAGE,
  form = VALID_FORM,
  holdPhase = "active",
  expiresAt = FUTURE_EXPIRY,
  step = 2,
  checkoutCodes = null,
} = {}) => {
  window.sessionStorage.setItem(
    "my_slot_hold",
    JSON.stringify({
      holdId: "hold_seeded_1",
      holdToken: "hold_token_seeded_1",
      expiresAt,
      startTimeUTC: FUTURE_SLOT,
      packageTitle: bookingPackage.title,
      packagePrice: bookingPackage.price,
      packageTag: bookingPackage.tag,
      phase: holdPhase,
    })
  );
  window.sessionStorage.setItem(
    "booking_modal_state",
    JSON.stringify({
      packageTitle: bookingPackage.title,
      step,
      selectedSlot: {
        slotId: FUTURE_SLOT,
        utcStart: FUTURE_SLOT,
        localLabel: "8:30 PM",
      },
    })
  );
  window.sessionStorage.setItem(
    "booking_draft",
    JSON.stringify({
      lastTitle: bookingPackage.title,
      packages: {
        [bookingPackage.title]: {
          selectedPackage: bookingPackage,
          form,
          ...(checkoutCodes ? { checkoutCodes } : {}),
        },
      },
    })
  );
};

const installDefaultFetch = ({
  settings = { dateSlots: [] },
  referrals = {},
  coupons = {},
} = {}) => {
  global.fetch = jest.fn(async (url) => {
    const requestUrl = String(url);
    if (requestUrl.startsWith("/api/ref/validateReferral")) {
      const code = new URL(requestUrl, "https://rooindustries.com")
        .searchParams.get("code")
        ?.toLowerCase();
      const referral = referrals[code];
      return {
        ok: !!referral,
        json: async () =>
          referral
            ? { ok: true, referral }
            : { ok: false, error: "Not found" },
      };
    }
    if (requestUrl.startsWith("/api/ref/validateCoupon")) {
      const code = new URL(requestUrl, "https://rooindustries.com")
        .searchParams.get("code")
        ?.toLowerCase();
      const coupon = coupons[code];
      return {
        ok: !!coupon,
        json: async () =>
          coupon
            ? { ok: true, coupon }
            : { ok: false, error: "Invalid referral or coupon code." },
      };
    }
    if (String(url).startsWith("/api/content/package")) {
      return {
        ok: true,
        json: async () => ({ ok: true, data: OVERHAUL_PACKAGE }),
      };
    }
    if (url === "/api/bookingAvailability") {
      return {
        ok: true,
        json: async () => ({ ok: true, settings, bookedSlots: [] }),
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
};

const expectActiveStep = (label, progress) => {
  const tracker = screen.getByTestId("booking-step-tracker");
  const activeStep = tracker.querySelector('[aria-current="step"]');
  expect(activeStep).toHaveTextContent(label);
  expect(within(tracker).getByText(progress)).toBeInTheDocument();
};

describe("booking calendar UI", () => {
  let resolvedOptionsSpy;

  beforeEach(() => {
    mockNavigate.mockReset();
    window.sessionStorage.clear();
    window.localStorage.clear();
    __setMockLocation({
      pathname: "/booking",
      search: "",
      hash: "",
      state: null,
    });
    resolvedOptionsSpy = jest
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ timeZone: "America/Los_Angeles" });
  });

  afterEach(() => {
    jest.useRealTimers();
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
        packagePrice: "$79.95",
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
        packagePrice: "$79.95",
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
              price: "$79.95",
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
          price: "$79.95",
          tag: "Test",
        },
      },
    });
    render(<BookingForm />);

    await waitFor(() =>
      expectActiveStep("Review & pay", "Step 3 of 3")
    );
    const releaseButton = await screen.findByRole("button", {
      name: /^release payment$/i,
    });
    expect(
      screen.getAllByRole("button", { name: /^return to payment$/i })
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^back$/i })).not.toBeInTheDocument();
    expect(releaseButton.parentElement).toHaveClass("grid", "sm:grid-cols-2");
    expect(
      screen.queryByRole("button", {
        name: /have a referral or coupon code/i,
      })
    ).not.toBeInTheDocument();

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
    expectActiveStep("Review & pay", "Step 3 of 3");
    expect(
      screen.getByRole("button", { name: /^pay \$54\.95$/i })
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

  test("shows a payment-cancellation error on step 3", async () => {
    seedBookingSession({ holdPhase: "payment_pending", step: 3 });
    window.sessionStorage.setItem(
      "payment_session_state",
      JSON.stringify({ paymentAccessToken: "payment_access_rejected_1" })
    );
    global.fetch = jest.fn(async (url) => {
      if (String(url).startsWith("/api/content/package")) {
        return {
          ok: true,
          json: async () => ({ ok: true, data: OVERHAUL_PACKAGE }),
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
        return {
          ok: false,
          json: async () => ({ error: "Payment cancellation was rejected." }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    setBookingLocation();

    render(<BookingForm />);

    await userEvent.click(
      await screen.findByRole("button", { name: /^release payment$/i })
    );

    const error = await screen.findByText(
      /^payment cancellation was rejected\.$/i
    );
    expect(error).toHaveClass("text-danger-text");
    expectActiveStep("Review & pay", "Step 3 of 3");
  });

  test("releases an ordinary step-3 hold when its countdown expires", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2099-01-05T05:59:55.000Z"));
    seedBookingSession({
      expiresAt: "2099-01-05T06:00:00.000Z",
      step: 3,
    });
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    await screen.findByText(/^expires in \d+:\d{2}\.$/i);
    await act(async () => {
      jest.advanceTimersByTime(6_000);
      await Promise.resolve();
    });

    expect(window.sessionStorage.getItem("my_slot_hold")).toBeNull();
    expect(
      global.fetch.mock.calls.filter(([url]) => url === "/api/releaseHold")
    ).toHaveLength(1);
  });

  test("clamps an expired payment-pending countdown and explains it on step 3", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2099-01-05T05:59:55.000Z"));
    seedBookingSession({
      expiresAt: "2099-01-05T06:00:00.000Z",
      holdPhase: "payment_pending",
      step: 3,
    });
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    await screen.findByText(/^expires in \d+:\d{2}\.$/i);
    await act(async () => {
      jest.advanceTimersByTime(6_000);
      await Promise.resolve();
    });

    expect(screen.getByText(/^expires in 0:00\.$/i)).toBeInTheDocument();
    expect(screen.getByText(PAYMENT_PENDING_EXPIRY_ERROR)).toHaveClass(
      "text-danger-text"
    );
    expectActiveStep("Review & pay", "Step 3 of 3");
    expect(window.sessionStorage.getItem("my_slot_hold")).not.toBeNull();
    expect(
      global.fetch.mock.calls.filter(([url]) => url === "/api/releaseHold")
    ).toHaveLength(0);
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

  test("renders semantic tracker states and validates before opening review", async () => {
    const utcStart = getUtcFromHostLocal(2099, 0, 5, 10);
    global.fetch = jest.fn(async (url) => {
      if (url === "/api/bookingAvailability") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            settings: { dateSlots: [{ date: "2099-01-05", times: ["10:00"] }] },
            bookedSlots: [],
          }),
        };
      }
      if (url === "/api/holdSlot") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            holdId: "hold_tracker_1",
            holdToken: "hold_token_tracker_1",
            expiresAt: FUTURE_EXPIRY,
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    setBookingLocation();

    render(<BookingForm />);

    await screen.findByRole("button", {
      name: formatLocalTime(utcStart, "America/Los_Angeles"),
    });
    expectActiveStep("Pick a slot", "Step 1 of 3");
    expect(screen.getByText(REASSURANCE_COPY)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", {
        name: formatLocalTime(utcStart, "America/Los_Angeles"),
      })
    );
    await userEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await screen.findByLabelText("Discord username");
    expectActiveStep("PC details", "Step 2 of 3");
    expect(
      screen.getByText("Performance Vertex Overhaul")
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /^review before payment$/i })
    );
    expectActiveStep("PC details", "Step 2 of 3");
    expect(
      screen.getByText("Please fill out all required fields.")
    ).toHaveClass("text-danger-text");

    await userEvent.type(screen.getByLabelText("Discord username"), "TrackerUser");
    await userEvent.type(screen.getByLabelText("Booking email"), CLIENT_EMAIL);
    await userEvent.type(screen.getByLabelText("PC specifications"), "7800X3D");
    await userEvent.type(
      screen.getByLabelText("Main game or application"),
      "Counter-Strike 2"
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^review before payment$/i })
    );

    await waitFor(() =>
      expectActiveStep("Review & pay", "Step 3 of 3")
    );
    expect(
      screen.getByText("No charge until you confirm on the payment page.")
    ).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Total").closest("div")).toHaveClass(
      "grid",
      "gap-1",
      "py-3",
      "sm:grid-cols-[9rem_1fr]"
    );
    expect(
      screen.queryByRole("link", { name: /verified reviews/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /submit & pay/i })
    ).not.toBeInTheDocument();
  });

  test("review shows the summary and Pay navigates with plain notes", async () => {
    seedBookingSession();
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    await userEvent.click(
      await screen.findByRole("button", { name: /^review before payment$/i })
    );

    await screen.findByRole("button", { name: /^pay \$54\.95$/i });
    expect(screen.getByText(VALID_FORM.discord)).toBeInTheDocument();
    expect(screen.getByText(VALID_FORM.email)).toBeInTheDocument();
    expect(screen.getByText(VALID_FORM.specs)).toBeInTheDocument();
    expect(screen.getByText(VALID_FORM.mainGame)).toBeInTheDocument();
    expect(screen.getByText(VALID_FORM.notes)).toBeInTheDocument();
    expect(screen.getByText(/America\/Los_Angeles/)).toBeInTheDocument();
    const totalRow = screen.getByText("Total").closest("div");
    const totalPrice = within(totalRow).getByText("$54.95");
    expect(totalPrice.tagName).toBe("DD");
    expect(totalPrice).toHaveClass(
      "text-lg",
      "font-bold",
      "text-accent",
      "sm:text-right"
    );
    expect(screen.queryByText("$79.95")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Price $54.95, previous price $79.95")
    ).not.toBeInTheDocument();
    expect(screen.getByText("90 day warranty included")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /^pay \$54\.95$/i })
    );

    expect(mockNavigate).toHaveBeenCalledWith(
      "/payment",
      expect.objectContaining({
        state: expect.objectContaining({
          bookingData: expect.objectContaining({
            message: "Keep fan noise low",
          }),
        }),
      })
    );
    const checkout = JSON.parse(
      sessionStorage.getItem("checkout_booking_state")
    );
    expect(checkout).not.toHaveProperty("goals");
    expect(checkout.message).toBe("Keep fan noise low");
    const draft = JSON.parse(sessionStorage.getItem("booking_draft"));
    expect(draft.packages[OVERHAUL_PACKAGE.title].form.notes).toBe(
      "Keep fan noise low"
    );
  });

  test("applies a coupon with Enter and keeps the discounted total across steps", async () => {
    seedBookingSession({ step: 3 });
    installDefaultFetch({ coupons: { save10: FIXED_COUPON } });
    setBookingLocation();

    render(<BookingForm />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: /have a referral or coupon code/i,
      })
    );
    await userEvent.type(screen.getByPlaceholderText("Enter code"), "SAVE10{enter}");

    expect(
      await screen.findByRole("button", { name: /^pay \$44\.95$/i })
    ).toBeInTheDocument();
    expect(screen.getByText("SAVE10 · −$10.00")).toBeInTheDocument();
    expect(within(screen.getByText("Total").closest("div")).getByText("$44.95"))
      .toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Enter code")).not.toBeInTheDocument();
    expect(
      JSON.parse(sessionStorage.getItem("booking_draft")).packages[
        OVERHAUL_PACKAGE.title
      ].checkoutCodes
    ).toEqual({
      referral: null,
      coupon: {
        code: "SAVE10",
        discountType: "fixed",
        discountAmount: 10,
        canCombineWithReferral: true,
      },
      dismissedReferralCode: "",
    });

    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));
    await userEvent.click(
      await screen.findByRole("button", { name: /^review before payment$/i })
    );
    expect(
      await screen.findByRole("button", { name: /^pay \$44\.95$/i })
    ).toBeInTheDocument();
  });

  test("keeps the code input open and shows an inline alert after failure", async () => {
    seedBookingSession({ step: 3 });
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: /have a referral or coupon code/i,
      })
    );
    const input = screen.getByPlaceholderText("Enter code");
    await userEvent.type(input, "NOTREAL{enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid referral or coupon code."
    );
    expect(input).toHaveValue("NOTREAL");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute(
      "aria-describedby",
      "booking-review-code-error"
    );
    expect(document.getElementById("booking-review-code-error")).toHaveTextContent(
      "Invalid referral or coupon code."
    );
  });

  test("removing an applied coupon restores Total and the Pay amount", async () => {
    seedBookingSession({ step: 3 });
    installDefaultFetch({ coupons: { save10: FIXED_COUPON } });
    setBookingLocation();

    render(<BookingForm />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: /have a referral or coupon code/i,
      })
    );
    await userEvent.type(screen.getByPlaceholderText("Enter code"), "SAVE10{enter}");
    await screen.findByRole("button", { name: /^pay \$44\.95$/i });
    await userEvent.click(
      screen.getByRole("button", { name: /remove coupon code save10/i })
    );

    expect(
      screen.getByRole("button", { name: /^pay \$54\.95$/i })
    ).toBeInTheDocument();
    expect(within(screen.getByText("Total").closest("div")).getByText("$54.95"))
      .toBeInTheDocument();
    expect(screen.queryByText("SAVE10 · −$10.00")).not.toBeInTheDocument();
  });

  test("automatically shows a validated referral from ?ref= with the input collapsed", async () => {
    seedBookingSession({ step: 3 });
    installDefaultFetch({ referrals: { creator: CREATOR_REFERRAL } });
    setBookingLocation(OVERHAUL_PACKAGE, "?ref=creator");

    render(<BookingForm />);

    expect(await screen.findByText("Referral")).toBeInTheDocument();
    expect(screen.getByText("creator · −$5.50")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Enter code")).not.toBeInTheDocument();
  });

  test("drops a restored referral session that no longer validates", async () => {
    seedBookingSession({ step: 3 });
    sessionStorage.setItem("referral_session", "expiredcreator");
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid referral or coupon code."
    );
    expect(sessionStorage.getItem("referral_session")).toBeNull();
    expect(screen.queryByText(/expiredcreator ·/i)).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /^pay \$54\.95$/i })
    );
    const bookingData = mockNavigate.mock.calls.at(-1)[1].state.bookingData;
    expect(bookingData).not.toHaveProperty("referralCode");
    expect(bookingData).not.toHaveProperty("couponCode");
  });

  test("carries stacked codes in the payload using shared payment-page math", async () => {
    seedBookingSession({ step: 3 });
    installDefaultFetch({
      referrals: { creator: CREATOR_REFERRAL },
      coupons: { club5: STACKING_COUPON },
    });
    setBookingLocation(OVERHAUL_PACKAGE, "?ref=creator");

    render(<BookingForm />);

    await screen.findByText("creator · −$5.50");
    await userEvent.click(
      screen.getByRole("button", {
        name: /have a referral or coupon code/i,
      })
    );
    await userEvent.type(screen.getByPlaceholderText("Enter code"), "CLUB5{enter}");

    const sharedPricing = calculateCheckoutDiscounts({
      baseAmount: 54.95,
      referral: CREATOR_REFERRAL,
      coupon: STACKING_COUPON,
    });
    const expectedTotal = `$${sharedPricing.finalAmount.toFixed(2)}`;
    const payButton = await screen.findByRole("button", {
      name: `Pay ${expectedTotal}`,
    });
    expect(sharedPricing).toMatchObject({
      couponDiscountAmount: 2.75,
      referralDiscountAmount: 5.22,
      finalAmount: 46.98,
    });

    await userEvent.click(payButton);

    expect(mockNavigate).toHaveBeenLastCalledWith(
      "/payment",
      expect.objectContaining({
        state: expect.objectContaining({
          bookingData: expect.objectContaining({
            referralCode: "creator",
            couponCode: "CLUB5",
          }),
        }),
      })
    );
    expect(
      JSON.parse(sessionStorage.getItem("checkout_booking_state"))
    ).toMatchObject({
      referralCode: "creator",
      couponCode: "CLUB5",
    });
  });

  test("restores an applied code from the per-package draft after reload", async () => {
    seedBookingSession({
      step: 3,
      checkoutCodes: {
        referral: null,
        coupon: FIXED_COUPON,
        dismissedReferralCode: "",
      },
    });
    installDefaultFetch({ coupons: { save10: FIXED_COUPON } });
    setBookingLocation();

    render(<BookingForm />);

    expect(await screen.findByText("SAVE10 · −$10.00")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^pay \$44\.95$/i })
    ).toBeInTheDocument();
    expect(
      JSON.parse(sessionStorage.getItem("booking_draft")).packages[
        OVERHAUL_PACKAGE.title
      ].checkoutCodes.coupon
    ).toEqual({
      code: "SAVE10",
      discountType: "fixed",
      discountAmount: 10,
      canCombineWithReferral: true,
    });
  });

  test("drops a restored coupon that no longer validates", async () => {
    seedBookingSession({
      step: 3,
      checkoutCodes: {
        referral: null,
        coupon: FIXED_COUPON,
        dismissedReferralCode: "",
      },
    });
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid referral or coupon code."
    );
    expect(screen.queryByText("SAVE10 · −$10.00")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter code")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: /^pay \$54\.95$/i })
    ).toBeInTheDocument();
    expect(
      JSON.parse(sessionStorage.getItem("booking_draft")).packages[
        OVERHAUL_PACKAGE.title
      ].checkoutCodes.coupon
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: /^pay \$54\.95$/i })
    );
    const bookingData = mockNavigate.mock.calls.at(-1)[1].state.bookingData;
    expect(bookingData).not.toHaveProperty("couponCode");
    expect(bookingData).not.toHaveProperty("referralCode");
  });

  test("resolves a collision as a sanitized referral and sends one code identity", async () => {
    const collisionReferral = {
      ...CREATOR_REFERRAL,
      code: "creatorfree",
      currentDiscountPercent: 100,
    };
    const collisionCoupon = {
      ...FIXED_COUPON,
      code: "CREATORFREE",
      discountAmount: 54.95,
    };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    seedBookingSession({ step: 3 });
    installDefaultFetch({
      referrals: { creatorfree: collisionReferral },
      coupons: { creatorfree: collisionCoupon },
    });
    setBookingLocation();

    render(<BookingForm />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: /have a referral or coupon code/i,
      })
    );
    await userEvent.type(
      screen.getByPlaceholderText("Enter code"),
      "CREATORFREE{enter}"
    );

    expect(await screen.findByText("creatorfree · −$54.95")).toBeInTheDocument();
    expect(screen.queryByText("CREATORFREE · −$54.95")).not.toBeInTheDocument();
    const draftCodes = JSON.parse(sessionStorage.getItem("booking_draft"))
      .packages[OVERHAUL_PACKAGE.title].checkoutCodes;
    expect(draftCodes).toEqual({
      referral: { code: "creatorfree", currentDiscountPercent: 100 },
      coupon: null,
      dismissedReferralCode: "",
    });

    await userEvent.click(
      screen.getByRole("button", { name: /^pay \$0\.00$/i })
    );
    const bookingData = mockNavigate.mock.calls.at(-1)[1].state.bookingData;
    expect(bookingData).toMatchObject({ referralCode: "creatorfree" });
    expect(bookingData).not.toHaveProperty("couponCode");
    expect(bookingData).not.toHaveProperty("referralId");
    expect(warn).toHaveBeenCalledWith(
      "checkout_code_namespace_collision",
      expect.objectContaining({
        code: "creatorfree",
        precedence: "referral_first",
      })
    );
    warn.mockRestore();
  });

  test("uses the payment fallback when the review price is zero", async () => {
    const missingPricePackage = {
      ...OVERHAUL_PACKAGE,
      price: "$0.00",
    };
    seedBookingSession({ bookingPackage: missingPricePackage, step: 3 });
    installDefaultFetch();
    setBookingLocation(missingPricePackage);

    render(<BookingForm />);

    expect(
      await screen.findByRole("button", { name: /^continue to payment$/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pay \$0\.01/i }))
      .not.toBeInTheDocument();
    expect(screen.getByText("Confirmed on payment page")).toBeInTheDocument();
  });

  test("step navigation edits and Back preserve the active hold", async () => {
    seedBookingSession();
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: /^review before payment$/i,
      })
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^edit details$/i })
    );
    await waitFor(() =>
      expectActiveStep("PC details", "Step 2 of 3")
    );

    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));
    await waitFor(() =>
      expectActiveStep("Pick a slot", "Step 1 of 3")
    );
    await userEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await userEvent.click(
      await screen.findByRole("button", {
        name: /^review before payment$/i,
      })
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^edit$/i })
    );

    await waitFor(() =>
      expectActiveStep("Pick a slot", "Step 1 of 3")
    );
    expect(sessionStorage.getItem("my_slot_hold")).not.toBeNull();
    expect(
      global.fetch.mock.calls.filter(([url]) => url === "/api/releaseHold")
    ).toHaveLength(0);
  });

  test("step-3 Back returns directly to step 2 without releasing the hold", async () => {
    seedBookingSession({ step: 3 });
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    await userEvent.click(
      await screen.findByRole("button", { name: /^back$/i })
    );

    await waitFor(() =>
      expectActiveStep("PC details", "Step 2 of 3")
    );
    expect(window.sessionStorage.getItem("my_slot_hold")).not.toBeNull();
    expect(
      global.fetch.mock.calls.filter(([url]) => url === "/api/releaseHold")
    ).toHaveLength(0);
  });

  test("earliest available selects across the full schedule and skips blocked slots", async () => {
    const bookedUtc = getUtcFromHostLocal(2099, 0, 5, 10).toISOString();
    const heldUtc = getUtcFromHostLocal(2099, 0, 6, 10).toISOString();
    const earliestUtcDate = getUtcFromHostLocal(2099, 1, 3, 10);
    let holdRequestBody = null;
    global.fetch = jest.fn(async (url, options = {}) => {
      if (url === "/api/bookingAvailability") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            settings: {
              dateSlots: [
                { date: "2099-01-05", times: ["10:00"] },
                { date: "2099-01-06", times: ["10:00"] },
                { date: "2099-02-03", times: ["10:00"] },
              ],
            },
            bookedSlots: [
              { startTimeUTC: bookedUtc },
              {
                startTimeUTC: heldUtc,
                isHold: true,
                holdId: "another_users_hold",
              },
            ],
          }),
        };
      }
      if (url === "/api/holdSlot") {
        holdRequestBody = JSON.parse(options.body || "{}");
        return {
          ok: true,
          json: async () => ({
            ok: true,
            holdId: "hold_earliest_1",
            holdToken: "hold_token_earliest_1",
            expiresAt: FUTURE_EXPIRY,
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    setBookingLocation();

    render(<BookingForm />);

    const expectedDate = new Intl.DateTimeFormat(undefined, {
      timeZone: "America/Los_Angeles",
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(earliestUtcDate);
    const expectedTime = formatLocalTime(
      earliestUtcDate,
      "America/Los_Angeles"
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: `Earliest available: ${expectedDate} at ${expectedTime}`,
      })
    );

    expect(
      screen.getByRole("heading", { name: "February 2099" })
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() => expect(holdRequestBody).not.toBeNull());
    expect(holdRequestBody.startTimeUTC).toBe(earliestUtcDate.toISOString());
  });

  test.each([
    [OVERHAUL_PACKAGE, "90 day warranty included", "Lifetime warranty included"],
    [MAX_PACKAGE, "Lifetime warranty included", "90 day warranty included"],
  ])(
    "uses the package warranty source for %s",
    async (bookingPackage, expectedWarranty, excludedWarranty) => {
      seedBookingSession({ bookingPackage, step: 3 });
      installDefaultFetch();
      setBookingLocation(bookingPackage);

      render(<BookingForm />);

      expect(await screen.findByText(expectedWarranty)).toBeInTheDocument();
      expect(screen.queryByText(excludedWarranty)).not.toBeInTheDocument();
    }
  );

  test("restores current-preview drafts while ignoring removed goal keys", async () => {
    seedBookingSession({
      form: {
        ...VALID_FORM,
        goals: ["Lowest latency", "More FPS"],
        goalsTouched: true,
      },
    });
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    expect(await screen.findByLabelText("Discord username")).toHaveValue(
      VALID_FORM.discord
    );
    expect(screen.queryByText("What matters most?")).not.toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText("Extra booking requirements"),
      " please"
    );
    await waitFor(() => {
      const stored = JSON.parse(sessionStorage.getItem("booking_draft"));
      expect(stored.packages[OVERHAUL_PACKAGE.title].form).toEqual({
        ...VALID_FORM,
        notes: "Keep fan noise low please",
      });
    });
  });

  test("restores step 3 without the hydration write resetting it", async () => {
    seedBookingSession({ step: 3 });
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    await waitFor(() =>
      expectActiveStep("Review & pay", "Step 3 of 3")
    );
    await waitFor(() => {
      const stored = JSON.parse(sessionStorage.getItem("booking_modal_state"));
      expect(stored.step).toBe(3);
    });
  });

  test("clamps an out-of-range restored step to step 3", async () => {
    seedBookingSession({ step: 99 });
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    await waitFor(() =>
      expectActiveStep("Review & pay", "Step 3 of 3")
    );
    expect(
      JSON.parse(sessionStorage.getItem("booking_modal_state")).step
    ).toBe(3);
  });

  test("final Pay revalidates restored details and returns invalid data to step 2", async () => {
    seedBookingSession({
      step: 3,
      form: {
        discord: "",
        email: "",
        specs: "",
        mainGame: "",
        notes: "",
      },
    });
    installDefaultFetch();
    setBookingLocation();

    render(<BookingForm />);

    await userEvent.click(
      await screen.findByRole("button", { name: /^pay \$54\.95$/i })
    );

    await waitFor(() =>
      expectActiveStep("PC details", "Step 2 of 3")
    );
    expect(
      screen.getByText("Please fill out all required fields.")
    ).toHaveClass("text-danger-text");
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
