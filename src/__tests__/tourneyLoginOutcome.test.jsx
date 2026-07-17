import { render, screen } from "@testing-library/react";
import TourneyLoginOutcome from "../../app/tourney/TourneyLoginOutcome";

describe("Tourney Discord login outcome", () => {
  test("keeps the successful link outcome visible", () => {
    render(<TourneyLoginOutcome outcome="discord-linked" />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Discord linked. You're signed in."
    );
  });

  test("keeps a post-login link failure visible", () => {
    render(<TourneyLoginOutcome outcome="discord-link-failed" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Discord linking did not complete. Try the Discord login again."
    );
  });
});
