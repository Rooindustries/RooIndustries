import React, { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import BookingForm from "../components/BookingForm";

let mockLocation = { pathname: "/booking", search: "", hash: "", state: null, key: "hydrated" };
let mockServerRender = false;

jest.mock("react-dom", () => {
  const actual = jest.requireActual("react-dom");
  return { ...actual, createPortal: (...args) => (mockServerRender ? null : actual.createPortal(...args)) };
});

jest.mock(
  "react-router-dom",
  () => ({
    __esModule: true,
    useLocation: () => mockLocation,
    useNavigate: () => jest.fn(),
    Link: ({ to, children, ...rest }) => (
      <a href={typeof to === "string" ? to : to?.pathname || "#"} {...rest}>
        {children}
      </a>
    ),
  }),
  { virtual: true }
);

const formRoot = (container) => container.querySelector(".ri-booking.transition-opacity");

describe("booking form page fade", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    window.sessionStorage.clear();
    global.fetch = jest.fn(() => new Promise(() => {}));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("returning to the hydrated entry before the fade timer ends leaves the form visible", async () => {
    const container = document.createElement("div");
    mockServerRender = true;
    container.innerHTML = renderToString(<BookingForm />);
    mockServerRender = false;
    document.body.appendChild(container);
    expect(formRoot(container).className).toContain("opacity-100");
    let root;
    await act(async () => {
      root = hydrateRoot(container, <BookingForm />);
    });
    expect(formRoot(container).className).toContain("opacity-100");

    mockLocation = { ...mockLocation, search: "?step=next", key: "next" };
    await act(async () => root.render(<BookingForm />));
    expect(formRoot(container).className).toContain("opacity-0");

    await act(async () => jest.advanceTimersByTime(20));
    mockLocation = { ...mockLocation, search: "", key: "hydrated" };
    await act(async () => root.render(<BookingForm />));
    await act(async () => jest.advanceTimersByTime(100));
    expect(formRoot(container).className).toContain("opacity-100");

    await act(async () => root.unmount());
    container.remove();
  });
});
