import { render, screen } from "@testing-library/react";
import TourneyLoginOutcome from "../../app/tourney/TourneyLoginOutcome";

describe("Tourney social login outcome", () => {
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

  test("keeps the successful Google link outcome visible", () => {
    render(<TourneyLoginOutcome outcome="google-linked" />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Google linked. You're signed in."
    );
  });

  test("keeps a post-login Google link failure visible", () => {
    render(<TourneyLoginOutcome outcome="google-link-failed" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Google linking did not complete. Try the Google login again."
    );
  });

  test("renders nothing for an unknown outcome", () => {
    const { container } = render(<TourneyLoginOutcome outcome="apple-linked" />);

    expect(container).toBeEmptyDOMElement();
  });
});
