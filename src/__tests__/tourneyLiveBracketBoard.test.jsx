import { act, render, screen } from "@testing-library/react";

import LiveBracketBoard from "../../app/tourney/bracket/LiveBracketBoard";

jest.mock("../../app/tourney/TourneyBracketView", () => ({ snapshot, showSchedule }) => (
  <div data-testid="bracket-view" data-show-schedule={showSchedule ? "true" : "false"}>
    {(snapshot.matches || []).map((match) => match.id).join(",")}
  </div>
));

jest.mock("../../app/tourney/bracket/BracketFitBoard", () => ({ children }) => (
  <div data-testid="bracket-fit-board">{children}</div>
));

const snapshot = ({ updatedAt, matchId, caster }) => ({
  ok: true,
  meta: { updatedAt },
  generated: true,
  matches: [{ id: matchId }],
  schedule: { casters: [caster] },
});

describe("LiveBracketBoard", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("refreshes the bracket and legend when the shared snapshot changes", async () => {
    const initialSnapshot = snapshot({
      updatedAt: "2026-08-15T07:00:00.000Z",
      matchId: "match-before",
      caster: { id: 3, label: "GMR", color: "red" },
    });
    const nextSnapshot = snapshot({
      updatedAt: "2026-08-15T07:00:05.000Z",
      matchId: "match-after",
      caster: { id: 4, label: "KimchiBapBop", color: "pink" },
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => nextSnapshot,
    });

    render(<LiveBracketBoard initialSnapshot={initialSnapshot} />);

    expect(screen.getByTestId("bracket-view")).toHaveTextContent("match-before");
    expect(screen.getByLabelText("Caster legend")).toHaveTextContent("GMR");

    await act(async () => {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/tourney/bracket", {
      cache: "no-store",
    });
    expect(screen.getByTestId("bracket-view")).toHaveTextContent("match-after");
    expect(screen.getByLabelText("Caster legend")).toHaveTextContent(
      "KimchiBapBop"
    );
  });
});
