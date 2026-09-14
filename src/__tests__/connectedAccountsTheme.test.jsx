import fs from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ConnectedAccounts from "../components/ConnectedAccounts";

jest.mock("../components/SupabaseSocialLogin", () =>
  function MockSupabaseSocialLogin({ action, linkProof }) {
    return (
      <button
        aria-label={`mock-${action}`}
        data-testid="social-login"
        /* Mirrors SupabaseSocialLogin: only reclaim is proof-gated now. */
        disabled={action === "reclaim" && !linkProof?.confirmed}
        type="button"
      />
    );
  }
);

describe("Referral connected accounts", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        domainAccount: true,
        providers: ["email"],
        unlinkableProviders: ["email"],
      }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });



  test("lets a signed-in account link a provider without confirming a password", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        domainAccount: true,
        providers: ["email"],
        unlinkableProviders: ["email"],
        linkProof: null,
      }),
    });
    render(<ConnectedAccounts flow="referral" nextPath="/referrals/dashboard" />);

    const linkControl = await screen.findByRole("button", { name: "mock-link" });
    expect(linkControl).toBeEnabled();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(
      screen.getByText("You're signed in, so you can link an account below.")
    ).toBeVisible();
  });

  test("keeps reclaim disabled until confirmation returns a valid expiry", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          domainAccount: true,
          providers: ["email"],
          unlinkableProviders: ["email"],
          linkProof: null,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      });
    render(<ConnectedAccounts flow="referral" nextPath="/referrals/dashboard" />);

    // Adding a provider is open to any signed-in account, so the link control is
    // enabled immediately and no confirmation box is offered for it.
    const linkControl = await screen.findByRole("button", { name: "mock-link" });
    expect(linkControl).toBeEnabled();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });



  test("requires a fresh unlink grant instead of reusing link confirmation", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        domainAccount: true,
        providers: ["email", "discord"],
        unlinkableProviders: ["email", "discord"],
      }),
    });
    render(<ConnectedAccounts flow="referral" nextPath="/referrals/dashboard" />);

    await waitFor(() => expect(screen.getByLabelText("Unlink discord")).toBeVisible());
    fireEvent.click(screen.getByLabelText("Unlink discord"));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Enter your current password, then select Unlink."
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("polls pending unlink through read-only identity inventory", async () => {
    jest.useFakeTimers();
    const initial = {
      ok: true,
      domainAccount: true,
      providers: ["email", "discord"],
      unlinkableProviders: ["email", "discord"],
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initial })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, syncPending: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...initial, providers: ["email"], unlinkableProviders: ["email"] }),
      });
    render(<ConnectedAccounts flow="referral" nextPath="/referrals/dashboard" />);
    await waitFor(() => expect(screen.getByLabelText("Unlink discord")).toBeVisible());

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "correct password" },
    });
    fireEvent.click(screen.getByLabelText("Unlink discord"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Discord unlinking is completing.")
    );
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("Discord: Not linked")).toBeVisible());

    expect(global.fetch).toHaveBeenNthCalledWith(
      4,
      "/api/auth/identities?flow=referral",
      { cache: "no-store" }
    );
    expect(global.fetch).toHaveBeenCalledTimes(4);
    jest.useRealTimers();
  });
});
