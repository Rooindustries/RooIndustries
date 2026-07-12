import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SupabaseSocialLogin from "../components/SupabaseSocialLogin";

const mockSignInWithOAuth = jest.fn();
const mockLinkIdentity = jest.fn();
const mockSignOut = jest.fn();

jest.mock("../lib/supabaseBrowser", () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      linkIdentity: (...args) => mockLinkIdentity(...args),
      signInWithOAuth: (...args) => mockSignInWithOAuth(...args),
      signOut: (...args) => mockSignOut(...args),
    },
  }),
}));

describe("Supabase social login", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_SOCIAL_AUTH_ENABLED = "1";
    delete process.env.NEXT_PUBLIC_TOURNEY_PREVIEW_OAUTH_MOCK;
    jest.clearAllMocks();
    mockSignInWithOAuth.mockResolvedValue({ error: null });
    mockLinkIdentity.mockResolvedValue({ error: null });
    mockSignOut.mockResolvedValue({ error: null });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        callbackUrl: "http://localhost/auth/callback?intent=11111111-1111-4111-8111-111111111111",
      }),
    });
  });

  test("stays hidden until social Auth is explicitly enabled", () => {
    process.env.NEXT_PUBLIC_SUPABASE_SOCIAL_AUTH_ENABLED = "0";
    const { container } = render(
      <SupabaseSocialLogin flow="referral" nextPath="/referrals/dashboard" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("shows disabled Tourney providers in side-effect-free previews", () => {
    process.env.NEXT_PUBLIC_SUPABASE_SOCIAL_AUTH_ENABLED = "0";
    process.env.NEXT_PUBLIC_TOURNEY_PREVIEW_OAUTH_MOCK = "1";
    render(
      <SupabaseSocialLogin flow="tourney" nextPath="/tourney" variant="tourney" />
    );

    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continue with Discord" })).toBeDisabled();
    expect(
      screen.getByText("Preview only. Google and Discord sign-in are disabled here.")
    ).toBeInTheDocument();
  });

  test.each([
    ["Continue with Google", "google"],
    ["Continue with Discord", "discord"],
  ])("starts %s through a server-bound intent", async (buttonLabel, provider) => {
    render(
      <SupabaseSocialLogin
        flow="referral"
        nextPath="/referrals/dashboard"
        variant="referral"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: buttonLabel }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/auth/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "signin",
          flow: "referral",
          provider,
          returnPath: "/referrals/dashboard",
        }),
      });
      expect(mockSignInWithOAuth).toHaveBeenCalledWith({
        provider,
        options: {
          redirectTo:
            "http://localhost/auth/callback?intent=11111111-1111-4111-8111-111111111111",
          ...(provider === "discord" ? { scopes: "identify email" } : {}),
        },
      });
    });
    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
  });

  test("uses linkIdentity without signing out the authenticated account", async () => {
    render(
      <SupabaseSocialLogin
        action="link"
        flow="tourney"
        nextPath="/tourney"
        providerIds={["discord"]}
        variant="tourney"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Link Discord" }));
    await waitFor(() => {
      expect(mockLinkIdentity).toHaveBeenCalledWith({
        provider: "discord",
        options: {
          redirectTo:
            "http://localhost/auth/callback?intent=11111111-1111-4111-8111-111111111111",
          scopes: "identify email guilds.join",
        },
      });
    });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
  });

  test("runs the draft saver before a social signup redirect", async () => {
    const saveDraft = jest.fn();
    render(
      <SupabaseSocialLogin
        action="signup"
        flow="referral"
        nextPath="/referrals/register"
        onBeforeRedirect={saveDraft}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign up with Google" }));
    await waitFor(() => expect(mockSignInWithOAuth).toHaveBeenCalled());
    expect(saveDraft).toHaveBeenCalledTimes(1);
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

  test("shows a useful error when the intent cannot start", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ ok: false, error: "unavailable" }),
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
