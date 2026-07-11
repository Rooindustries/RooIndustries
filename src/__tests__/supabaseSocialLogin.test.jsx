import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SocialLogin from "../../app/account/login/social-login";

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
  ])("starts %s with the secure callback", async (buttonLabel, provider) => {
    render(<SocialLogin nextPath="/account" />);

    fireEvent.click(screen.getByRole("button", { name: buttonLabel }));

    await waitFor(() => {
      expect(mockSignInWithOAuth).toHaveBeenCalledWith({
        provider,
        options: {
          redirectTo: "http://localhost/auth/callback?next=%2Faccount",
        },
      });
    });
  });

  test("shows a useful error when the provider cannot start", async () => {
    mockSignInWithOAuth.mockResolvedValueOnce({
      error: new Error("provider unavailable"),
    });
    render(<SocialLogin nextPath="/account" />);

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(
      await screen.findByText("Sign-in could not be started. Please try again.")
    ).toBeInTheDocument();
  });
});
