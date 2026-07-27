import { render, screen } from "@testing-library/react";

jest.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

jest.mock("next/navigation", () => ({
  redirect: jest.fn(),
  usePathname: () => "/tourney/login",
}));

const TourneyLoginPage = require("../../app/tourney/login/page.jsx").default;

describe("Tourney login page", () => {
  test("renders the approved unlinked Discord credential prompt", async () => {
    render(
      await TourneyLoginPage({
        searchParams: Promise.resolve({
          error: "unlinked",
          next: "/tourney/manage",
          provider: "discord",
        }),
      })
    );

    expect(
      screen.getByRole("heading", { name: "No account linked yet" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This Discord account isn't linked to a tournament account yet. Enter your Tourney username and password once and we'll link it."
      )
    ).toHaveClass("is-wrapped");
    expect(
      screen.getByRole("button", { name: "Log in and link Discord" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent === "Registration is closed. View the roster."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View the roster." })
    ).toHaveAttribute("href", "/tourney/roster");
    expect(
      screen.queryByRole("button", { name: "Continue with Discord" })
    ).not.toBeInTheDocument();
  });

  test("renders the same prompt for an unlinked Google sign-in", async () => {
    render(
      await TourneyLoginPage({
        searchParams: Promise.resolve({
          error: "unlinked",
          provider: "google",
        }),
      })
    );

    expect(
      screen.getByRole("heading", { name: "No account linked yet" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This Google account isn't linked to a tournament account yet. Enter your Tourney username and password once and we'll link it."
      )
    ).toHaveClass("is-wrapped");
    expect(
      screen.getByRole("button", { name: "Log in and link Google" })
    ).toBeInTheDocument();
  });

  test("shows the plain sign-in form for an unknown provider", async () => {
    render(
      await TourneyLoginPage({
        searchParams: Promise.resolve({
          error: "unlinked",
          provider: "apple",
        }),
      })
    );

    expect(
      screen.getByRole("heading", { name: "Sign in." })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Log in and link/ })
    ).not.toBeInTheDocument();
  });
});
