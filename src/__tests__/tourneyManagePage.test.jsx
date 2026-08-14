import React from "react";
import { render, screen } from "@testing-library/react";

const mockGetTourneySession = jest.fn();
const mockReadAdminTourneyPlayers = jest.fn();

jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

jest.mock("../../app/tourney/TourneyShared", () => ({
  LockScreen: () => <div data-testid="lock-screen" />,
  RouteTitle: ({ children }) => <header>{children}</header>,
  Section: ({ children }) => <section>{children}</section>,
  TourneyShell: ({ children, performanceMode }) => (
    <main data-performance-mode={performanceMode ? "true" : "false"}>
      {children}
    </main>
  ),
  getTourneySession: (...args) => mockGetTourneySession(...args),
}));

jest.mock("../../app/tourney/OwnerAccountManager", () => () => (
  <div data-testid="account-manager" />
));

jest.mock("../../app/tourney/TourneyPlayerManager", () => () => (
  <div data-testid="player-manager" />
));

jest.mock("../server/tourney/auth", () => ({
  readEffectiveTourneyAccounts: jest.fn(async () => []),
  summarizeTourneyAccounts: jest.fn(() => []),
}));

jest.mock("../server/tourney/readService", () => ({
  readAdminTourneyPlayers: (...args) =>
    mockReadAdminTourneyPlayers(...args),
}));

const TourneyManagePage = require("../../app/tourney/manage/page.jsx").default;

describe("Tourney manage page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTourneySession.mockResolvedValue({
      username: "serviroo",
      role: "owner",
    });
    mockReadAdminTourneyPlayers.mockResolvedValue({
      ok: true,
      players: [],
      capacity: { teamCount: 8, roles: [] },
    });
  });

  test("does not seed editable roster controls when the initial read fails", async () => {
    mockReadAdminTourneyPlayers.mockRejectedValue(new Error("database unavailable"));

    render(await TourneyManagePage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("alert").textContent).toContain(
      "Roster controls are disabled"
    );
    expect(screen.queryByTestId("player-manager")).toBeNull();
    expect(screen.queryByText("Bracket Control")).toBeNull();
    expect(screen.getByRole("main")).toHaveAttribute(
      "data-performance-mode",
      "true"
    );
  });

  test("rejects caster sessions before loading Manage data", async () => {
    mockGetTourneySession.mockResolvedValue({
      username: "yukari",
      role: "caster",
    });

    await expect(
      TourneyManagePage({ searchParams: Promise.resolve({}) })
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockReadAdminTourneyPlayers).not.toHaveBeenCalled();
  });
});
