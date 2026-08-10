import { render, screen } from "@testing-library/react";
import TourneyBracketManager from "../../app/tourney/TourneyBracketManager";

jest.mock("../../app/tourney/TourneyBracketView", () => () => (
  <div data-testid="bracket-view" />
));

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
