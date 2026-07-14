import React from "react";
import { render, screen } from "@testing-library/react";

const mockGetTourneySession = jest.fn();
const mockReadAdminTourneyPlayers = jest.fn();
const mockGetTourneyBracketSnapshot = jest.fn();

jest.mock("next/navigation", () => ({
  notFound: jest.fn(),
}));

jest.mock("../../app/tourney/TourneyShared", () => ({
  LockScreen: () => <div data-testid="lock-screen" />,
  RouteTitle: ({ children }) => <header>{children}</header>,
  Section: ({ children }) => <section>{children}</section>,
  TourneyShell: ({ children }) => <main>{children}</main>,
  getTourneySession: (...args) => mockGetTourneySession(...args),
}));

jest.mock("../../app/tourney/OwnerAccountManager", () => () => (
  <div data-testid="account-manager" />
));

jest.mock("../../app/tourney/TourneyBracketManager", () => () => (
  <div data-testid="bracket-manager" />
));

jest.mock("../../app/tourney/TourneyPlayerManager", () => () => (
  <div data-testid="player-manager" />
));

jest.mock("../server/tourney/auth", () => ({
  readEffectiveTourneyAccounts: jest.fn(async () => []),
  summarizeTourneyAccounts: jest.fn(() => []),
}));

jest.mock("../server/tourney/bracketStore", () => ({
  getTourneyBracketSnapshot: (...args) =>
    mockGetTourneyBracketSnapshot(...args),
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
      username: "yukari",
      role: "caster",
    });
    mockReadAdminTourneyPlayers.mockResolvedValue({
      ok: true,
      players: [],
      capacity: { teamCount: 8, roles: [] },
    });
    mockGetTourneyBracketSnapshot.mockResolvedValue({
      ok: true,
      meta: {},
      teams: [],
      matches: [],
      groups: [],
      generated: false,
      audit: [],
    });
  });

  test("does not seed editable roster controls when the initial read fails", async () => {
    mockReadAdminTourneyPlayers.mockRejectedValue(new Error("database unavailable"));

    render(await TourneyManagePage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("alert").textContent).toContain(
      "Roster controls are disabled"
    );
    expect(screen.queryByTestId("player-manager")).toBeNull();
    expect(screen.getByTestId("bracket-manager")).not.toBeNull();
  });

  test("does not seed editable bracket controls when the initial read fails", async () => {
    mockGetTourneyBracketSnapshot.mockRejectedValue(new Error("database unavailable"));

    render(await TourneyManagePage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("alert").textContent).toContain(
      "Bracket controls are disabled"
    );
    expect(screen.queryByTestId("bracket-manager")).toBeNull();
    expect(screen.getByTestId("player-manager")).not.toBeNull();
  });
});
