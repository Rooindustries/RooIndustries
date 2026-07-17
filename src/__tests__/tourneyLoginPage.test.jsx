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
        "This Discord isn't linked to a tournament account yet. Enter your Tourney username and password once and we'll link it."
      )
    ).toHaveClass("is-wrapped");
    expect(
      screen.getByRole("button", { name: "Log in and link Discord" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent === "New here? Register for the tournament."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Register for the tournament." })
    ).toHaveAttribute("href", "/tourney/register");
    expect(
      screen.queryByRole("button", { name: "Continue with Discord" })
    ).not.toBeInTheDocument();
  });
});
