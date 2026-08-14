import { render, screen } from "@testing-library/react";
import TourneyBracketManager from "../../app/tourney/TourneyBracketManager";

jest.mock("../../app/tourney/TourneyBracketView", () => () => (
  <div data-testid="bracket-view" />
));

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
  expect(screen.queryByText("Add team")).not.toBeInTheDocument();
  expect(screen.queryByText("Generate bracket")).not.toBeInTheDocument();
  expect(screen.queryByText("Reset bracket")).not.toBeInTheDocument();
  expect(screen.getByText("Recent Bracket Activity (1)").closest("details")).not.toHaveAttribute(
    "open"
  );
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
