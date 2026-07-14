import fs from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ConnectedAccounts from "../components/ConnectedAccounts";

jest.mock("../components/SupabaseSocialLogin", () =>
  function MockSupabaseSocialLogin() {
    return <div data-testid="social-login" />;
  }
);

describe("Tourney connected accounts theme and layout", () => {
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

  test("uses dedicated Tourney controls instead of unstyled browser inputs", async () => {
    const { container } = render(
      <ConnectedAccounts flow="tourney" nextPath="/tourney" variant="tourney" />
    );

    await waitFor(() => expect(screen.getByLabelText("Current password")).toBeVisible());
    expect(container.querySelector("section")).toHaveClass("tourney-connected-accounts");
    expect(screen.getByLabelText("Current password")).toHaveClass(
      "tourney-connected-input"
    );
    expect(screen.getByRole("button", { name: "Confirm identity" })).toHaveClass(
      "tourney-connected-confirm"
    );
  });

  test("styles the card and controls exclusively through active theme tokens", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app", "tourney", "TourneyShared.jsx"),
      "utf8"
    );
    expect(source).toContain(".tourney-connected-reauth {");
    expect(source).toContain("grid-template-columns: minmax(0, 1fr) auto;");
    expect(source).toContain("border: 1px solid var(--tourney-border-accent);");
    expect(source).toContain("background: var(--tourney-input);");
    expect(source).toContain("color: var(--tourney-text);");
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
    render(<ConnectedAccounts flow="tourney" nextPath="/tourney" variant="tourney" />);

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
    render(<ConnectedAccounts flow="tourney" nextPath="/tourney" variant="tourney" />);
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
      "/api/auth/identities?flow=tourney",
      { cache: "no-store" }
    );
    expect(global.fetch).toHaveBeenCalledTimes(4);
    jest.useRealTimers();
  });
});
