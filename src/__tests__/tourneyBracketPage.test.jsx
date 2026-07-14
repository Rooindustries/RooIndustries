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

jest.mock("../../app/tourney/TourneyBracketView", () => ({ snapshot }) => (
  <div data-testid="bracket-view">{JSON.stringify(snapshot)}</div>
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
});
