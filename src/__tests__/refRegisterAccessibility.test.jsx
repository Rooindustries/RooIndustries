import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import RefRegister from "../components/RefRegister";

jest.mock("../components/SupabaseSocialLogin", () => () => null);

describe("referral registration accessibility", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ authenticated: false }),
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const fillRegistration = (password) => {
    for (const [label, value] of [
      ["Discord Username", "creator"],
      ["Login Email", "creator@example.com"],
      ["PayPal Email (for payouts)", "creator-paypal@example.com"],
      ["Referral Code", "creator-code"],
      ["Password", password],
      ["Confirm Password", password],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
  };

  test.each(["a".repeat(73), `${"🔒".repeat(18)}a`, ` ${"a".repeat(71)} `])(
    "rejects oversized passwords without shortening them or registering: %s", (password) => {
      render(<MemoryRouter><RefRegister /></MemoryRouter>);
      fillRegistration(password);
      fireEvent.click(screen.getByRole("button", { name: "Register" }));
      expect(screen.getByRole("alert")).toHaveTextContent("72 UTF-8 bytes");
      expect(screen.getByLabelText("Password")).toHaveValue(password);
      expect(global.fetch.mock.calls.some(([url]) => url === "/api/ref/register")).toBe(false);
    }
  );

  test("submits a 72-byte password including its leading and trailing spaces", async () => {
    const password = ` ${"a".repeat(70)} `;
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      json: async () => url === "/api/ref/register"
        ? { ok: true, pendingVerification: true }
        : url.startsWith("/api/ref/validateReferral")
          ? { reason: "available" }
          : { authenticated: false },
    }));
    render(<MemoryRouter><RefRegister /></MemoryRouter>);
    fillRegistration(password);
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => {
      const request = global.fetch.mock.calls.find(([url]) => url === "/api/ref/register");
      expect(request).toBeDefined();
      expect(JSON.parse(request[1].body).password).toBe(password);
    });
  });

  test.each(["short", "🔒".repeat(19), "valid-password"])(
    "discards a typed password when a verified social identity arrives late: %s", async (password) => {
      let resolveIdentity;
      const identity = new Promise(resolve => { resolveIdentity = resolve; });
      global.fetch = jest.fn((url) => {
        if (url.startsWith("/api/auth/identities")) return identity;
        return Promise.resolve({
          ok: true,
          json: async () => url === "/api/ref/register"
            ? { ok: true, pendingVerification: true }
            : { reason: "available" },
        });
      });
      render(<MemoryRouter><RefRegister /></MemoryRouter>);
      fillRegistration(password);
      await act(async () => {
        resolveIdentity({ ok: true, json: async () => ({
          authenticated: true,
          emailVerified: true,
          email: "verified-creator@example.com",
        }) });
      });
      expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Confirm Password")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Register" }));
      await waitFor(() => {
        const request = global.fetch.mock.calls.find(([url]) => url === "/api/ref/register");
        expect(request).toBeDefined();
        expect(JSON.parse(request[1].body)).toEqual(expect.objectContaining({
          email: "verified-creator@example.com",
          password: "",
        }));
      });
    }
  );

  test("announces validation errors immediately", () => {
    render(
      <MemoryRouter>
        <RefRegister />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: "Register" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Please fill in all fields.");
  });
});
