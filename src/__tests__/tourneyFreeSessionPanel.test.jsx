import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TourneyFreeSession from "../../app/tourney/TourneyFreeSession";

const FUTURE_HOST_DATE = "2099-08-03";
const SLOT_10AM_UTC = "2099-08-03T04:30:00.000Z";
const SLOT_230PM_UTC = "2099-08-03T09:00:00.000Z";

const availabilityBody = () => ({
  settings: {
    dateSlots: [{ date: FUTURE_HOST_DATE, times: ["10:00", "14:30"] }],
    xocDateSlots: [],
    vertexEssentialsDateSlots: [],
    packageDateSlots: [],
  },
  bookedSlots: [{ startTimeUTC: SLOT_10AM_UTC, isHold: false }],
});

const availableState = () => ({
  ok: true,
  packageTitle: "Tourney Free Optimization",
  availabilityUrl: "/api/bookingAvailability",
  entitlement: {
    id: "ent-1",
    status: "available",
    bookingId: "",
    consumedAt: "",
    booking: null,
  },
});

const consumedState = () => ({
  ok: true,
  packageTitle: "Tourney Free Optimization",
  availabilityUrl: "/api/bookingAvailability",
  entitlement: {
    id: "ent-1",
    status: "consumed",
    bookingId: "booking-1",
    consumedAt: "2099-07-30T10:00:00.000Z",
    booking: {
      id: "booking-1",
      startTimeUTC: SLOT_230PM_UTC,
      status: "captured",
    },
  },
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const localTimeLabel = (iso) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

const localDateLabel = (iso) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));

const mockFetchRouter = (overrides = {}) => {
  const calls = [];
  const fetchMock = jest.fn(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const key = `${options.method || "GET"} ${String(url)}`;
    if (overrides[key]) return overrides[key](calls.length);
    if (String(url) === "/api/tourney/free-session") {
      return jsonResponse(availableState());
    }
    if (String(url) === "/api/bookingAvailability") {
      return jsonResponse(availabilityBody());
    }
    return jsonResponse({ ok: false, error: "unexpected" }, 500);
  });
  global.fetch = fetchMock;
  return { fetchMock, calls };
};

describe("TourneyFreeSession", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("renders nothing when the entitlement is null", async () => {
    mockFetchRouter({
      "GET /api/tourney/free-session": () =>
        jsonResponse({
          ok: true,
          packageTitle: "Tourney Free Optimization",
          availabilityUrl: "/api/bookingAvailability",
          entitlement: null,
        }),
    });
    const { container } = render(<TourneyFreeSession />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => {
      expect(global.fetch.mock.calls.length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  test("renders nothing when the session lookup returns 404", async () => {
    mockFetchRouter({
      "GET /api/tourney/free-session": () =>
        jsonResponse({ ok: false, error: "Not found." }, 404),
    });
    const { container } = render(<TourneyFreeSession />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  test("shows the booked session when the entitlement is consumed", async () => {
    mockFetchRouter({
      "GET /api/tourney/free-session": () => jsonResponse(consumedState()),
    });
    render(<TourneyFreeSession />);
    expect(
      await screen.findByText("Your free session is booked")
    ).toBeInTheDocument();
    const expectedDate = localDateLabel(SLOT_230PM_UTC).replace(
      /^[A-Za-z]+, /,
      ""
    );
    expect(
      screen.getByText(new RegExp(expectedDate.replace(/ /g, "\\s+")))
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(localTimeLabel(SLOT_230PM_UTC)))
    ).toBeInTheDocument();
    expect(screen.getByText(/captured/)).toBeInTheDocument();
  });

  test("renders the booking calendar with availability states", async () => {
    mockFetchRouter();
    render(<TourneyFreeSession />);

    expect(
      await screen.findByRole("button", { name: "Previous month" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Next month" })
    ).toBeInTheDocument();
    expect(screen.getByText("Sun")).toBeInTheDocument();
    expect(screen.getByText("Sat")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Few left")).toBeInTheDocument();
    expect(screen.getByText("Booked out")).toBeInTheDocument();
    expect(screen.getByText("On hold")).toBeInTheDocument();

    const expectedDayLabel = new Intl.DateTimeFormat(undefined, {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(SLOT_230PM_UTC));
    const dayCell = await screen.findByRole("button", {
      name: new RegExp(`${expectedDayLabel}, a few left`),
    });
    expect(dayCell).toBeInTheDocument();

    const earliest = screen.getByRole("button", {
      name: /First open slot:/,
    });
    fireEvent.click(earliest);
    const slotButton = screen.getByRole("button", {
      name: localTimeLabel(SLOT_230PM_UTC),
    });
    expect(slotButton).toHaveAttribute("aria-pressed", "true");
  });

  test("lists only unbooked slots and books the selected time", async () => {
    const { calls } = mockFetchRouter({
      "POST /api/tourney/free-session": () => jsonResponse(consumedState()),
    });
    render(<TourneyFreeSession />);

    const slotButton = await screen.findByRole("button", {
      name: localTimeLabel(SLOT_230PM_UTC),
    });
    expect(
      screen.queryByRole("button", { name: localTimeLabel(SLOT_10AM_UTC) })
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/email for the confirmation/i), {
      target: { value: "player@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText(/discord username/i), {
      target: { value: "player#1234" },
    });
    fireEvent.click(slotButton);
    fireEvent.click(
      screen.getByRole("button", { name: "Book my session" })
    );

    expect(
      await screen.findByText("Your free session is booked")
    ).toBeInTheDocument();

    const postCall = calls.find(
      (call) => call.options.method === "POST"
    );
    expect(postCall).toBeDefined();
    const key = postCall.options.headers["Idempotency-Key"];
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);
    const payload = JSON.parse(postCall.options.body);
    expect(payload).toMatchObject({
      action: "book",
      startTimeUTC: SLOT_230PM_UTC,
      email: "player@example.com",
      discord: "player#1234",
    });
    expect(payload.timezone).toBeTruthy();
  });

  test("shows the server error and refreshes slots on slot conflict", async () => {
    let availabilityFetches = 0;
    const { calls } = mockFetchRouter({
      "GET /api/bookingAvailability": () => {
        availabilityFetches += 1;
        return jsonResponse(availabilityBody());
      },
      "POST /api/tourney/free-session": () =>
        jsonResponse(
          {
            ok: false,
            error: "That session time was just taken. Pick another slot.",
            code: "TOURNEY_FREE_SESSION_SLOT_CONFLICT",
          },
          409
        ),
    });
    render(<TourneyFreeSession />);

    const slotButton = await screen.findByRole("button", {
      name: localTimeLabel(SLOT_230PM_UTC),
    });
    fireEvent.change(screen.getByPlaceholderText(/email for the confirmation/i), {
      target: { value: "player@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText(/discord username/i), {
      target: { value: "player#1234" },
    });
    fireEvent.click(slotButton);
    fireEvent.click(
      screen.getByRole("button", { name: "Book my session" })
    );

    expect(
      await screen.findByText(/just taken. Pick another slot/i)
    ).toBeInTheDocument();
    await waitFor(() => expect(availabilityFetches).toBeGreaterThan(1));
    const postCalls = calls.filter((call) => call.options.method === "POST");
    expect(postCalls).toHaveLength(1);
  });

  test("flips to the consumed view when booking reports already booked", async () => {
    let stateFetches = 0;
    mockFetchRouter({
      "GET /api/tourney/free-session": () => {
        stateFetches += 1;
        return jsonResponse(
          stateFetches > 1 ? consumedState() : availableState()
        );
      },
      "POST /api/tourney/free-session": () =>
        jsonResponse(
          {
            ok: false,
            error: "Your free session has already been booked.",
            code: "TOURNEY_FREE_SESSION_ALREADY_BOOKED",
          },
          409
        ),
    });
    render(<TourneyFreeSession />);

    const slotButton = await screen.findByRole("button", {
      name: localTimeLabel(SLOT_230PM_UTC),
    });
    fireEvent.change(screen.getByPlaceholderText(/email for the confirmation/i), {
      target: { value: "player@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText(/discord username/i), {
      target: { value: "player#1234" },
    });
    fireEvent.click(slotButton);
    fireEvent.click(
      screen.getByRole("button", { name: "Book my session" })
    );

    expect(
      await screen.findByText("Your free session is booked")
    ).toBeInTheDocument();
    expect(stateFetches).toBeGreaterThan(1);
  });
});
