import React from "react";
import { render, screen } from "@testing-library/react";

const mockGetTourneySession = jest.fn();
const mockGetTourneyBracketSnapshot = jest.fn();

jest.mock("next/navigation", () => ({
  notFound: jest.fn(),
}));

jest.mock("../../app/tourney/TourneyShared", () => ({
  LockScreen: ({ redirectTo }) => (
    <div data-testid="lock-screen" data-redirect-to={redirectTo} />
  ),
  RouteTitle: ({ children }) => <header>{children}</header>,
  Section: ({ children }) => <section>{children}</section>,
  TourneyShell: ({ activeHref, children, performanceMode, wide }) => (
    <main
      data-active-href={activeHref}
      data-performance-mode={performanceMode ? "true" : "false"}
      data-wide={wide ? "true" : "false"}
    >
      {children}
    </main>
  ),
  getTourneySession: (...args) => mockGetTourneySession(...args),
}));

jest.mock("../../app/tourney/TourneyBracketManager", () => (props) => (
  <div
    data-testid="bracket-manager"
    data-role={props.currentRole}
    data-username={props.currentUsername}
    data-operations-only={props.operationsOnly ? "true" : "false"}
  />
));

jest.mock("../server/tourney/bracketStore", () => ({
  getTourneyBracketSnapshot: (...args) => mockGetTourneyBracketSnapshot(...args),
}));

const TourneyControlPage = require("../../app/tourney/control/page.jsx").default;

describe("Tourney control page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTourneySession.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });
    mockGetTourneyBracketSnapshot.mockResolvedValue({
      ok: true,
      generated: true,
      teams: [],
      matches: [],
      groups: [],
      audit: [],
    });
  });

  test("opens a focused wide control desk for casters", async () => {
    render(await TourneyControlPage({ searchParams: Promise.resolve({}) }));

    const shell = screen.getByRole("main");
    expect(shell).toHaveAttribute("data-active-href", "/tourney/control");
    expect(shell).toHaveAttribute("data-wide", "true");
    expect(shell).toHaveAttribute("data-performance-mode", "true");
    expect(mockGetTourneyBracketSnapshot).toHaveBeenCalledWith({
      includeAudit: true,
    });
    expect(screen.getByTestId("bracket-manager")).toHaveAttribute(
      "data-role",
      "caster"
    );
    expect(screen.getByTestId("bracket-manager")).toHaveAttribute(
      "data-operations-only",
      "true"
    );
    expect(screen.getByTestId("bracket-manager")).toHaveAttribute(
      "data-username",
      "yukari"
    );
  });

  test("returns to the control route after sign-in", async () => {
    mockGetTourneySession.mockResolvedValue(null);

    render(await TourneyControlPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId("lock-screen")).toHaveAttribute(
      "data-redirect-to",
      "/tourney/control"
    );
  });

  test("disables controls when bracket data is unavailable", async () => {
    mockGetTourneyBracketSnapshot.mockRejectedValue(new Error("database unavailable"));

    render(await TourneyControlPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Match controls are disabled"
    );
    expect(screen.queryByTestId("bracket-manager")).toBeNull();
  });
});
