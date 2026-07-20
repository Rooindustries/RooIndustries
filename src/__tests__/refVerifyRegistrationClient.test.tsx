import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import RefVerifyRegistration from "../components/RefVerifyRegistration";

const originalFetch = global.fetch;
const verificationToken = "A".repeat(43);

const renderVerification = () =>
  render(
    <MemoryRouter initialEntries={["/referrals/verify"]}>
      <RefVerifyRegistration />
    </MemoryRouter>
  );

describe("referral registration confirmation client", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(
      null,
      "",
      `/referrals/verify#token=${verificationToken}`
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  test("reads the browser fragment when the MemoryRouter entry has no token", async () => {
    renderVerification();

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/ref/verifyRegistration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: verificationToken }),
      });
    });
    expect(
      await screen.findByText("Email confirmed. Your creator account is ready.")
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/referrals/verify");
    expect(window.location.hash).toBe("");
  });

  test("removes a definitively rejected token from session storage", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        error: "Invalid or expired confirmation link.",
      }),
    });

    renderVerification();

    expect(
      await screen.findByText("Invalid or expired confirmation link.")
    ).toBeInTheDocument();
    expect(
      window.sessionStorage.getItem("referral_registration_verification")
    ).toBeNull();
  });
});
