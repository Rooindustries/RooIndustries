import { render, screen } from "@testing-library/react";

const mockGetTourneySession = jest.fn();
const mockReadTourneyService = jest.fn();

jest.mock("../../app/tourney/TourneyShared", () => ({
  StatusPanel: ({ label, title, children }) => (
    <section aria-label={label}>
      <h3>{title}</h3>
      <p>{children}</p>
    </section>
  ),
  TourneyShell: ({ children }) => <main>{children}</main>,
  getTourneySession: (...args) => mockGetTourneySession(...args),
}));

jest.mock("../../app/tourney/TourneyBracketView", () => ({ snapshot, showSchedule }) => (
  <div data-testid="bracket-view" data-show-schedule={showSchedule ? "true" : "false"}>
    {JSON.stringify(snapshot)}
  </div>
));

jest.mock("../server/tourney/readService", () => ({
  readTourneyService: (...args) => mockReadTourneyService(...args),
}));

const TourneyBracketPage = require("../../app/tourney/bracket/page").default;

describe("Tourney bracket page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTourneySession.mockResolvedValue(null);
  });

  test("renders the live bracket snapshot", async () => {
    mockReadTourneyService.mockResolvedValue({
      status: 200,
      ok: true,
      body: { generated: true, matches: [{ id: "match-1" }] },
    });

    render(await TourneyBracketPage());

    expect(mockReadTourneyService).toHaveBeenCalledWith({ route: "public_bracket" });
    expect(screen.getByTestId("bracket-view")).toHaveTextContent("match-1");
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

    expect(screen.getByText("Live bracket data is reconnecting")).toBeInTheDocument();
    expect(screen.getByTestId("bracket-view")).toHaveTextContent("{}");
  });

  test("enables the schedule view and renders the caster legend", async () => {
    mockReadTourneyService.mockResolvedValue({
      status: 200,
      ok: true,
      body: {
        generated: true,
        matches: [],
        schedule: {
          timeZone: "UTC",
          casters: [
            { id: 1, label: "Yukari + SpankyCheeze" },
            { id: 6, label: "TheLemonGeneral or To Be Determined" },
          ],
        },
      },
    });

    render(await TourneyBracketPage());

    expect(screen.getByTestId("bracket-view")).toHaveAttribute(
      "data-show-schedule",
      "true"
    );
    const legend = screen.getByLabelText("Caster legend");
    expect(legend).toHaveTextContent("Caster 1");
    expect(legend).toHaveTextContent("Yukari + SpankyCheeze");
    expect(legend).toHaveTextContent("TheLemonGeneral or To Be Determined");
  });
});
