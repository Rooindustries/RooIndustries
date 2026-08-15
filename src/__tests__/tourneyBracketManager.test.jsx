import { render, screen } from "@testing-library/react";
import TourneyBracketManager from "../../app/tourney/TourneyBracketManager";

let mockRenderControls;

jest.mock("../../app/tourney/TourneyBracketView", () => (props) => {
  mockRenderControls = props.renderControls;
  return <div data-testid="bracket-view" />;
});

test("renders an operations-only desk without owner setup controls", () => {
  render(
    <TourneyBracketManager
      currentRole="owner"
      operationsOnly
      initialSnapshot={{
        generated: true,
        teams: [{ id: "team-1", name: "Alpha", seed: 1, status: "active" }],
        matches: [
          { id: "ready", statusLabel: "Ready", autoAdvance: false },
          { id: "running", statusLabel: "Running", autoAdvance: false },
          { id: "completed", statusLabel: "Completed", autoAdvance: false },
        ],
        audit: [
          {
            id: "audit-1",
            action: "bracket.generate",
            actorUsername: "serviroo",
            reason: "",
            createdAt: "2026-08-04T21:50:29.870Z",
          },
        ],
      }}
    />
  );

  expect(screen.getByText("Live match desk")).toBeInTheDocument();
  expect(screen.getByText("1 live · 1 ready · 1 completed")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Public bracket" })).toHaveAttribute(
    "href",
    "/tourney/bracket"
  );
  expect(screen.getByRole("link", { name: "Stream overlays" })).toHaveAttribute(
    "href",
    "/tourney/overlay"
  );
  expect(screen.getByRole("link", { name: "Public bracket" }).parentElement).toHaveClass(
    "is-control-links"
  );
  expect(screen.queryByText("Add team")).not.toBeInTheDocument();
  expect(screen.queryByText("Generate bracket")).not.toBeInTheDocument();
  expect(screen.queryByText("Reset bracket")).not.toBeInTheDocument();
  expect(screen.queryByText("Recent Bracket Activity (1)")).not.toBeInTheDocument();
});

test("renders controls for main hosts on every match", () => {
  render(
    <TourneyBracketManager
      currentRole="caster"
      currentUsername="yukari"
      operationsOnly
      initialSnapshot={{ generated: true, teams: [], matches: [], audit: [] }}
    />
  );

  const match = {
    id: 22,
    displayLabel: "Grand Final",
    statusLabel: "Ready",
    targetScore: 4,
    schedule: { casterIds: [1, 2] },
    opponent1: { teamId: "team-1", name: "Alpha", score: "" },
    opponent2: { teamId: "team-2", name: "Bravo", score: "" },
  };
  const { rerender } = render(mockRenderControls(match));
  expect(screen.getByRole("button", { name: "Start live" })).toBeInTheDocument();

  rerender(
    mockRenderControls({
      ...match,
      id: 13,
      schedule: { casterIds: [6] },
    })
  );
  expect(screen.getByRole("button", { name: "Start live" })).toBeInTheDocument();
});

test("keeps ordinary casters restricted to assigned matches", () => {
  render(
    <TourneyBracketManager
      currentRole="caster"
      currentUsername="gmr"
      operationsOnly
      initialSnapshot={{ generated: true, teams: [], matches: [], audit: [] }}
    />
  );

  const match = {
    id: 1,
    displayLabel: "Match 1",
    statusLabel: "Ready",
    targetScore: 3,
    schedule: { casterIds: [3] },
    opponent1: { teamId: "team-1", name: "Alpha", score: "" },
    opponent2: { teamId: "team-2", name: "Bravo", score: "" },
  };
  const { rerender } = render(mockRenderControls(match));
  expect(screen.getByRole("button", { name: "Start live" })).toBeInTheDocument();

  rerender(mockRenderControls({
    ...match,
    id: 13,
    schedule: { casterIds: [6, 7] },
  }));
  expect(screen.queryByRole("button", { name: "Start live" })).toBeNull();
});

test("renders database audit timestamps without treating Date objects as children", () => {
  const createdAt = new Date("2026-08-10T06:15:00.000Z");

  render(
    <TourneyBracketManager
      currentRole="owner"
      initialSnapshot={{
        generated: true,
        teams: [],
        matches: [],
        audit: [
          {
            id: "audit-1",
            action: "bracket.generate",
            actorUsername: "serviroo",
            reason: "",
            createdAt,
          },
        ],
      }}
    />
  );

  expect(screen.getByText(createdAt.toISOString())).toBeInTheDocument();
});
