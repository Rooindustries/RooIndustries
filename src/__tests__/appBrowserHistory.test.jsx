import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import LegacyRoutePage from "../next/LegacyRoutePage";

jest.mock("../components/Navbar", () => function NavigationFixture() {
  const { Link, useLocation, useNavigate } = require("react-router-dom");
  const BackButton = require("../components/BackButton").default;
  const location = useLocation();
  const navigate = useNavigate();
  return <nav>
    <output data-testid="route">{location.pathname}{location.search}{location.hash}</output>
    <Link to="/tools">Tools fixture</Link>
    <Link to="/reviews">Reviews fixture</Link>
    <Link to="/referrals/dashboard">Dashboard fixture</Link>
    <Link to="/booking" state={{ backgroundLocation: location }}>Book fixture</Link>
    <button onClick={() => {
      window.history.pushState(window.history.state, "", "/#packages");
      navigate("/");
    }}>Section fixture</button>
    <BackButton inline />
  </nav>;
});
jest.mock("../components/ReservationBanner", () => () => null);
jest.mock("../components/IntercomMessenger", () => () => null);
jest.mock("../components/PerfDebugOverlay", () => () => null);
jest.mock("../components/BookingModal", () => ({ children }) => <div role="dialog">{children}</div>);
jest.mock("../legacyPages/Home", () => () => <p>HOME FIXTURE</p>);
jest.mock("../legacyPages/Tools", () => () => <p>TOOLS FIXTURE</p>);
jest.mock("../legacyPages/Reviews", () => () => <p>REVIEWS FIXTURE</p>);
jest.mock("../legacyPages/Book", () => () => <p>BOOKING FIXTURE</p>);
jest.mock("../legacyPages/Payment", () => () => <p>PAYMENT FIXTURE</p>);
jest.mock("../legacyPages/RefLogin", () => () => <p>LOGIN FIXTURE</p>);
jest.mock("../legacyPages/RefReset", () => () => <p>RESET FIXTURE</p>);
jest.mock("../legacyPages/RefDashboard", () => function RedirectFixture() {
  const { Navigate } = require("react-router-dom");
  return <Navigate to="/referrals/login" replace />;
});
jest.mock("../lib/performanceProfile", () => ({ initializePerformanceProfile: jest.fn() }));
jest.mock("../lib/scrollRuntime", () => ({ useScrollRuntime: () => ({ scrollY: 0, direction: "up" }) }));
jest.mock("../lib/homeSectionData", () => ({ prefetchHomeSectionData: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));
jest.mock("@vercel/speed-insights/react", () => ({ SpeedInsights: () => null }));

const nextState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["", { children: ["__PAGE__", {}] }] };
let pushSpy;
const click = (name) => fireEvent.click(screen.getByRole("link", { name }));
const expectRoute = async (pathname) => waitFor(() => {
  expect(window.location.pathname).toBe(pathname);
  expect(screen.getByTestId("route").textContent.split(/[?#]/)[0]).toBe(pathname);
});
const traverse = async (direction, pathname) => {
  await act(async () => { window.history[direction](); });
  await expectRoute(pathname);
};

beforeEach(() => {
  sessionStorage.clear();
  window.scrollTo = jest.fn();
  window.history.replaceState(nextState, "", "/");
  pushSpy = jest.spyOn(window.history, "pushState");
});
afterEach(() => jest.restoreAllMocks());

test("real MemoryRouter links create native entries and browser Back/Forward restores route content", async () => {
  render(<LegacyRoutePage pathname="/" />);
  click("Tools fixture");
  await screen.findByText("TOOLS FIXTURE");
  expect(pushSpy).toHaveBeenCalledTimes(1);
  expect(window.history.state).toMatchObject(nextState);
  await traverse("back", "/");
  expect(screen.getByText("HOME FIXTURE")).toBeInTheDocument();
  await traverse("forward", "/tools");
  expect(screen.getByText("TOOLS FIXTURE")).toBeInTheDocument();
});

test("redirects replace their own entry and do not add a dashboard loop", async () => {
  render(<LegacyRoutePage pathname="/" />);
  click("Dashboard fixture");
  await screen.findByText("LOGIN FIXTURE");
  expect(pushSpy).toHaveBeenCalledTimes(1);
  await expectRoute("/referrals/login");
  await traverse("back", "/");
  await traverse("forward", "/referrals/login");
});

test("browser history restores the booking modal background and state", async () => {
  render(<LegacyRoutePage pathname="/" />);
  click("Tools fixture");
  await screen.findByText("TOOLS FIXTURE");
  click("Book fixture");
  await screen.findByText("BOOKING FIXTURE");
  expect(window.history.state.usr.backgroundLocation.pathname).toBe("/tools");
  expect(screen.getByRole("dialog")).toHaveTextContent("BOOKING FIXTURE");
  expect(screen.getByText("TOOLS FIXTURE")).toBeInTheDocument();
  await traverse("back", "/tools");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await traverse("forward", "/booking");
  expect(screen.getByRole("dialog")).toHaveTextContent("BOOKING FIXTURE");
  expect(screen.getByText("TOOLS FIXTURE")).toBeInTheDocument();
});

test("the site Back button follows native history after browser traversal", async () => {
  render(<LegacyRoutePage pathname="/" />);
  click("Tools fixture");
  await screen.findByText("TOOLS FIXTURE");
  click("Reviews fixture");
  await screen.findByText("REVIEWS FIXTURE");
  await traverse("back", "/tools");
  await traverse("forward", "/reviews");
  fireEvent.click(screen.getByRole("button", { name: "Go Back" }));
  await expectRoute("/tools");
});

test("adopts Navbar's existing section entry without a second push", async () => {
  render(<LegacyRoutePage pathname="/" />);
  click("Tools fixture");
  await screen.findByText("TOOLS FIXTURE");
  pushSpy.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Section fixture" }));
  await screen.findByText("HOME FIXTURE");
  expect(pushSpy).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe("#packages");
  await traverse("back", "/tools");
  await traverse("forward", "/");
  expect(window.location.hash).toBe("#packages");
});

test("initial hydration scrubs sensitive query values while preserving Next and checkout state", async () => {
  const usr = { bookingEmailDispatchToken: "fixture-dispatch" };
  window.history.replaceState({ ...nextState, usr }, "", "/referrals/reset?token=secret#type=recovery&access_token=access&refresh_token=refresh");
  render(<LegacyRoutePage pathname="/referrals/reset" searchParams={{ token: "secret" }} />);
  await screen.findByText("RESET FIXTURE");
  expect(window.location.search).toBe("");
  expect(window.location.hash).toBe("#type=recovery&access_token=access&refresh_token=refresh");
  expect(window.history.state).toMatchObject({ ...nextState, usr });
  expect(pushSpy).not.toHaveBeenCalled();
});
