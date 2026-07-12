import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TourneyLoginForm from "../../app/tourney/TourneyLoginForm";

const assign = jest.fn();

describe("Tourney login form", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    assign.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("submits through same-page JSON and redirects only after success", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    render(
      <TourneyLoginForm navigate={assign} redirectTo="/tourney/manage" />
    );

    fireEvent.change(screen.getByLabelText("Discord username or email"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/tourney/login", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: "owner@example.com",
          password: "correct-password",
          rememberMe: false,
          redirectTo: "/tourney/manage",
        }),
      });
      expect(assign).toHaveBeenCalledWith("/tourney/manage");
    });
  });

  test("keeps an API error on the login page", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: "Invalid login." }),
    });
    render(<TourneyLoginForm navigate={assign} />);

    fireEvent.change(screen.getByLabelText("Discord username or email"), {
      target: { value: "invalid" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login.");
    expect(assign).not.toHaveBeenCalled();
  });
});
