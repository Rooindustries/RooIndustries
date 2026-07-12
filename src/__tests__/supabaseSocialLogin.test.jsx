import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SupabaseSocialLogin from "../components/SupabaseSocialLogin";

const mockSignInWithOAuth = jest.fn();

jest.mock("../lib/supabaseBrowser", () => ({
  getSupabaseBrowserClient: () => ({
    auth: { signInWithOAuth: (...args) => mockSignInWithOAuth(...args) },
  }),
}));

describe("Supabase social login", () => {
  beforeEach(() => {
    mockSignInWithOAuth.mockReset();
    mockSignInWithOAuth.mockResolvedValue({ error: null });
  });

  test.each([
    ["Continue with Google", "google"],
    ["Continue with Discord", "discord"],
  ])("starts %s from the existing referral login", async (buttonLabel, provider) => {
    render(
      <SupabaseSocialLogin
        flow="referral"
        nextPath="/referrals/dashboard"
        variant="referral"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: buttonLabel }));

    await waitFor(() => {
      expect(mockSignInWithOAuth).toHaveBeenCalledWith({
        provider,
        options: {
          redirectTo:
            "http://localhost/auth/callback?flow=referral&next=%2Freferrals%2Fdashboard",
        },
      });
    });
  });

  test("renders the official provider marks in the Tourney treatment", () => {
    const { container } = render(
      <SupabaseSocialLogin flow="tourney" nextPath="/tourney" variant="tourney" />
    );

    expect(container.querySelectorAll("svg")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toHaveClass(
      "cs-social-button"
    );
  });

  test("shows a useful error when the provider cannot start", async () => {
    mockSignInWithOAuth.mockResolvedValueOnce({
      error: new Error("provider unavailable"),
    });
    render(
      <SupabaseSocialLogin
        flow="referral"
        nextPath="/referrals/dashboard"
        variant="referral"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(
      await screen.findByText("Sign-in could not be started. Please try again.")
    ).toBeInTheDocument();
  });
});
