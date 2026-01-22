import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BookingForm from "../components/BookingForm";
import { client } from "../sanityClient";

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

jest.mock("../sanityClient", () => ({
  client: {
    fetch: jest.fn(),
  },
}));

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
    client.fetch.mockReset();
    mockNavigate.mockReset();
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

    client.fetch.mockImplementation(async (query) => {
      const q = String(query || "");
      if (q.includes('_type == "bookingSettings"')) return settings;
      if (q.includes('_type == "booking"')) return [];
      if (q.includes('_type == "slotHold"')) return [];
      return null;
    });

    let holdRequestBody = null;
    global.fetch = jest.fn(async (url, options = {}) => {
      if (url === "/api/holdSlot") {
        holdRequestBody = JSON.parse(options.body || "{}");
        return {
          ok: true,
          json: async () => ({
            ok: true,
            holdId: "hold_ui_1",
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
      search:
        "?title=Performance%20Vertex%20Overhaul&price=%2484.99&tag=Test&xoc=0",
      state: null,
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
});
