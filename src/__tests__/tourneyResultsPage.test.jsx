import { render, screen } from "@testing-library/react";
import TourneyResultsPage from "../../app/tourney/page";

test("the public archive shows the confirmed podium without an account session", () => {
  render(<TourneyResultsPage />);
  expect(screen.getByRole("heading", { name: "GetSkii’d" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Rents Due" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "FerociousFurrys" })).toBeVisible();
  expect(screen.getByLabelText("Grand final: GetSkii’d 4, Rents Due 1")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Stay Tuned." })).toBeVisible();
  expect(screen.getByRole("main")).toHaveAttribute("data-tourney-state", "results");
  for (const link of screen.getAllByRole("link")) {
    expect(link.getAttribute("href")).not.toMatch(/^\/(?:api\/tourney|tourney\/(?:login|register|manage|control))/);
  }
});
