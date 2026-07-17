import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import RefLogin from "../components/RefLogin";
import RefRegister from "../components/RefRegister";

jest.mock("../components/SupabaseSocialLogin", () => () => null);

const response = (payload, ok = true) => ({
  ok,
  json: async () => payload,
});

const renderReferralAuth = () =>
  render(
    <MemoryRouter initialEntries={["/referrals/login?oauth=unlinked&provider=discord"]}>
      <Routes>
        <Route path="/referrals/login" element={<RefLogin />} />
        <Route path="/referrals/register" element={<RefRegister />} />
        <Route path="/referrals/dashboard" element={<p>Referral dashboard</p>} />
      </Routes>
    </MemoryRouter>
  );

describe("unlinked referral Discord account choice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState(
      null,
      "",
      "/referrals/login?oauth=unlinked&provider=discord"
    );
    window.requestAnimationFrame = (callback) => {
      callback();
      return 1;
    };
    window.scrollTo = jest.fn();
    global.fetch = jest.fn((url) => {
      if (String(url) === "/api/ref/getData") {
        return Promise.resolve(response({ ok: false }, false));
      }
      if (String(url) === "/api/auth/identities?flow=referral") {
        return Promise.resolve(
          response({
            authenticated: true,
            email: "discord-creator@example.com",
            emailVerified: true,
            providers: ["discord"],
          })
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
  });

  test("shows the approved account choice after an unlinked Discord sign-in", async () => {
    renderReferralAuth();

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No account linked yet" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "This Discord isn't linked to a creator account yet. Already registered? Log in and we'll link your Discord to it. New here? Create your account."
    );
    expect(screen.getByRole("button", { name: "Log in and link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });

  test("logs in and links the preserved Discord identity", async () => {
    global.fetch.mockImplementation((url, options = {}) => {
      if (String(url) === "/api/ref/getData") {
        return Promise.resolve(response({ ok: false }, false));
      }
      if (String(url) === "/api/ref/login") {
        return Promise.resolve(
          response({ ok: true, code: "creator", discordLinked: true })
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    renderReferralAuth();

    fireEvent.click(await screen.findByRole("button", { name: "Log in and link" }));
    fireEvent.change(screen.getByLabelText("Referral code or login email"), {
      target: { value: "creator@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/ref/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "creator@example.com",
          linkDiscord: true,
          password: "correct-password",
          rememberMe: false,
        }),
      });
    });
    expect(
      await screen.findByText("Discord linked to your account.")
    ).toBeInTheDocument();
  });

  test("carries the Discord session into the existing registration flow", async () => {
    renderReferralAuth();

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));

    expect(
      await screen.findByRole("heading", { name: "Referral Creator Registration" })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Login Email")).toHaveValue(
        "discord-creator@example.com"
      );
    });
    expect(screen.getByLabelText("Login Email")).toHaveAttribute("readonly");
    expect(
      screen.getByText(
        "Verified as discord-creator@example.com. You can use Google or Discord to sign in."
      )
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });
});
