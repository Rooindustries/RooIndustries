import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import RefChangePassword from "../components/RefChangePassword";
import RefReset from "../components/RefReset";

const mockExchangeCodeForSession = jest.fn();
const mockSetSession = jest.fn();
const mockVerifyOtp = jest.fn();

jest.mock("../lib/supabaseBrowser", () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      exchangeCodeForSession: (...args) => mockExchangeCodeForSession(...args),
      setSession: (...args) => mockSetSession(...args),
      verifyOtp: (...args) => mockVerifyOtp(...args),
    },
  }),
}));

const renderReset = (entry) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <RefReset />
    </MemoryRouter>
  );

describe("referral Supabase recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/referrals/reset");
    mockSetSession.mockResolvedValue({
      data: { session: { user: { id: "creator-user" } } },
      error: null,
    });
    mockExchangeCodeForSession.mockResolvedValue({ data: null, error: null });
    mockVerifyOtp.mockResolvedValue({ data: null, error: null });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("establishes the recovery session before removing the link fragment", async () => {
    renderReset(
      "/referrals/reset#access_token=recovery-access&refresh_token=recovery-refresh&type=recovery"
    );

    expect(
      await screen.findByRole("heading", { name: "Reset Password" })
    ).toBeInTheDocument();
    expect(mockSetSession).toHaveBeenCalledWith({
      access_token: "recovery-access",
      refresh_token: "recovery-refresh",
    });
    expect(window.location.hash).toBe("");
  });

  test("associates reset password labels with their fields", async () => {
    renderReset(
      "/referrals/reset#access_token=recovery-access&refresh_token=recovery-refresh&type=recovery"
    );

    expect(await screen.findByLabelText("New Password")).toHaveAttribute(
      "id",
      "ref-reset-new-password"
    );
    expect(screen.getByLabelText("Confirm Password")).toHaveAttribute(
      "id",
      "ref-reset-confirm-password"
    );
  });

  test("updates the password through the authenticated recovery endpoint", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, signedOut: true }),
    });
    renderReset(
      "/referrals/reset#access_token=recovery-access&refresh_token=recovery-refresh&type=recovery"
    );

    fireEvent.change(await screen.findByPlaceholderText("Enter new password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm new password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Password" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/ref/recoverPassword", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "new-password-123" }),
        signal: expect.any(AbortSignal),
      });
    });
    expect(
      await screen.findByText(
        "Password updated. Log in with your new password."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Password" })).toBeEnabled();
  });

  test("renders the pending copy and polls until the password is updated", async () => {
    jest.useFakeTimers();
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({
          ok: true,
          status: "pending",
          message: "Your password change is saving. It will finish in a moment.",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, status: "updated" }),
      });
    renderReset(
      "/referrals/reset#access_token=recovery-access&refresh_token=recovery-refresh&type=recovery"
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.change(screen.getByPlaceholderText("Enter new password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm new password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Password" }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByText(
        "Your password change is saving. It will finish in a moment."
      )
    ).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByText("Password updated. Log in with your new password.")
    ).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("renders the password API error instead of a generic silent failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        ok: false,
        error: "Password update is temporarily unavailable. Please try again.",
      }),
    });
    renderReset(
      "/referrals/reset#access_token=recovery-access&refresh_token=recovery-refresh&type=recovery"
    );

    fireEvent.change(await screen.findByPlaceholderText("Enter new password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm new password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Password" }));

    expect(
      await screen.findByText(
        "Password update is temporarily unavailable. Please try again."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Password" })).toBeEnabled();
  });

  test("clears the busy state and surfaces a timed-out update", async () => {
    jest.useFakeTimers();
    jest.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = jest.fn((_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })
    );
    renderReset(
      "/referrals/reset#access_token=recovery-access&refresh_token=recovery-refresh&type=recovery"
    );

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.change(screen.getByPlaceholderText("Enter new password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm new password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Password" }));
    expect(screen.getByRole("button", { name: "Updating..." })).toBeDisabled();

    await act(async () => {
      jest.advanceTimersByTime(15_000);
      await Promise.resolve();
    });

    expect(
      screen.getByText("Password update took too long. Please try again.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Password" })).toBeEnabled();
  });

  test("keeps legacy referral reset links working", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    const token = "a".repeat(64);
    renderReset(`/referrals/reset#token=${token}`);

    fireEvent.change(await screen.findByPlaceholderText("Enter new password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm new password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Password" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/ref/reset",
        expect.objectContaining({
          body: JSON.stringify({ token, password: "new-password-123" }),
        })
      );
    });
    expect(mockSetSession).not.toHaveBeenCalled();
  });
});

const renderChangePassword = () =>
  render(
    <MemoryRouter initialEntries={["/referrals/change-password"]}>
      <RefChangePassword />
    </MemoryRouter>
  );

const fillAndSubmitPasswordChange = async () => {
  fireEvent.change(await screen.findByPlaceholderText("Enter current password"), {
    target: { value: "current-password-123" },
  });
  fireEvent.change(screen.getByPlaceholderText("Enter new password"), {
    target: { value: "new-password-456" },
  });
  fireEvent.change(screen.getByPlaceholderText("Confirm new password"), {
    target: { value: "new-password-456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save Password" }));
};

describe("referral signed-in password change outcomes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState(null, "", "/referrals/change-password");
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const installFetch = (passwordResponse) => {
    global.fetch = jest.fn(async (url) => {
      if (String(url) === "/api/ref/getData") {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (String(url) === "/api/auth/reauth") {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (String(url) === "/api/ref/hashPassword") {
        return passwordResponse;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  };

  test("associates change password labels with all three fields", async () => {
    installFetch({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    renderChangePassword();

    expect(await screen.findByLabelText("Current Password")).toHaveAttribute(
      "id",
      "ref-change-current-password"
    );
    expect(screen.getByLabelText("New Password")).toHaveAttribute(
      "id",
      "ref-change-new-password"
    );
    expect(screen.getByLabelText("Confirm Password")).toHaveAttribute(
      "id",
      "ref-change-confirm-password"
    );
  });

  test("renders the completed password copy", async () => {
    installFetch({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        status: "updated",
        message: "Password updated. Log in with your new password.",
      }),
    });
    renderChangePassword();

    await fillAndSubmitPasswordChange();

    expect(
      await screen.findByText("Password updated. Log in with your new password.")
    ).toBeInTheDocument();
  });

  test("renders the durable-write pending copy", async () => {
    installFetch({
      ok: true,
      status: 202,
      json: async () => ({
        ok: true,
        status: "pending",
        message: "Your password change is saving. It will finish in a moment.",
      }),
    });
    renderChangePassword();

    await fillAndSubmitPasswordChange();

    expect(
      await screen.findByText(
        "Your password change is saving. It will finish in a moment."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Password" })).toBeEnabled();
  });

  test("renders the active-operation error instead of silently clearing it", async () => {
    installFetch({
      ok: false,
      status: 503,
      json: async () => ({
        ok: false,
        error:
          "A previous password change is still in progress. Please try again shortly.",
      }),
    });
    renderChangePassword();

    await fillAndSubmitPasswordChange();

    expect(
      await screen.findByText(
        "A previous password change is still in progress. Please try again shortly."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Password" })).toBeEnabled();
  });
});
