import { render, screen } from "@testing-library/react";

const mockGetTourneySession = jest.fn();
const mockReadPublicTourneyRoster = jest.fn();
const mockReadTourneyService = jest.fn();

jest.mock("../../app/tourney/TourneyShared", () => ({
  StatusPanel: ({ label, title, children }) => (
    <section aria-label={label}>
      <h3>{title}</h3>
      <p>{children}</p>
    </section>
  ),
  TourneyShell: ({ children, performanceMode }) => (
    <main data-performance-mode={performanceMode === false ? "false" : "true"}>
      {children}
    </main>
  ),
  getTourneySession: (...args) => mockGetTourneySession(...args),
}));

jest.mock("../../app/tourney/bracket/LiveBracketBoard", () => ({ initialSnapshot }) => (
  <div data-testid="live-bracket-board">{JSON.stringify(initialSnapshot)}</div>
));

jest.mock("../server/tourney/readService", () => ({
  readPublicTourneyRoster: (...args) => mockReadPublicTourneyRoster(...args),
  readTourneyService: (...args) => mockReadTourneyService(...args),
}));

const TourneyBracketPage = require("../../app/tourney/bracket/page").default;

describe("Tourney bracket page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTourneySession.mockResolvedValue(null);
    mockReadPublicTourneyRoster.mockResolvedValue({ players: [] });
  });

  test("renders the live bracket snapshot", async () => {
    mockReadTourneyService.mockResolvedValue({
      status: 200,
      ok: true,
      body: { generated: true, matches: [{ id: "match-1" }] },
    });

    render(await TourneyBracketPage());

    expect(mockReadTourneyService).toHaveBeenCalledWith({ route: "public_bracket" });
    expect(screen.getByRole("main")).toHaveAttribute("data-performance-mode", "false");
    expect(screen.getByTestId("live-bracket-board")).toHaveTextContent("match-1");
    expect(screen.queryByLabelText("Temporarily unavailable")).not.toBeInTheDocument();
  });

  test("keeps the public page usable when the database is unavailable", async () => {
    mockReadTourneyService.mockResolvedValue({
      status: 503,
      ok: false,
      errorCode: "TOURNEY_DATABASE_UNAVAILABLE",
      body: null,
    });

    render(await TourneyBracketPage());

    expect(screen.getByTestId("live-bracket-board")).toHaveTextContent("{}");
  });

  test("passes the schedule and caster legend to the live board", async () => {
    mockReadTourneyService.mockResolvedValue({
      status: 200,
      ok: true,
      body: {
        generated: true,
        matches: [],
        schedule: {
          timeZone: "PST",
          casters: [
            { id: 1, label: "Yukari + SpankyCheeze", color: "purple" },
            { id: 6, label: "Lemon", color: "yellow" },
          ],
        },
      },
    });

    render(await TourneyBracketPage());

    const liveBoard = screen.getByTestId("live-bracket-board");
    expect(liveBoard).toHaveTextContent("PST");
    expect(liveBoard).toHaveTextContent("Yukari + SpankyCheeze");
    expect(liveBoard).toHaveTextContent("Lemon");
    expect(liveBoard).not.toHaveTextContent("To Be Determined");
  });
});
